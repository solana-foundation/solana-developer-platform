//! Signs and sends. Before it signs, the wallet verifies the transaction against its own RPC:
//! every instruction must sit in a segment that the verifier proves, unless the caller lists it as
//! one that it accepts unverified, as an intent with its onchain checks off needs. Each spend from
//! the Privacy Rings pool must sit in a shielded segment, and be exactly an instruction that the
//! wallet built from the statement that the segment's intent requires. The notes are hidden
//! onchain, so the key holder is the one party that can check them.

use base64::Engine as _;
use serde_json::{json, Value};

use sdp_intents_client::message::WireMessage;
use std::collections::HashMap;

use sdp_intents_planner::{Instruction, ProviderSignature, ShieldedSpend, VerifiedTransaction};
use sdp_intents_privacy_rings::pool_program;
use sdp_intents_spec::Address;

use crate::error::WalletError;
use crate::{fingerprint, Wallet};

impl Wallet {
    /// A body of `{ "message": base64, "presigned"?: [...], "unverified"?: [positions] }`: checks the
    /// transaction, signs with each key that the message requires, and sends. `unverified` lists the
    /// instructions that the caller accepts with no proof, which must be exactly the ones that no
    /// segment proves.
    pub fn send(&self, body: &Value) -> Result<Value, WalletError> {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .map(|text| base64::engine::general_purpose::STANDARD.decode(text))
            .ok_or_else(|| WalletError::invalid_request("the body holds `message`, a base64 message"))?
            .map_err(|error| WalletError::invalid_request(format!("`message` is not base64: {error}")))?;
        let accepted = accepted_unverified(body)?;

        let spent = self.check(&message, &accepted)?;
        let signature = self.client.send_presigned(&message, &self.keys.keypairs(), &presigned(body)?)?;
        self.forget(&spent)?;

        Ok(json!({ "signature": signature.to_string() }))
    }

    /// Returns the fingerprints of the spends that the transaction signs, which the wallet forgets
    /// once it sends, so that it signs each spend once.
    fn check(&self, message: &[u8], accepted: &[usize]) -> Result<Vec<Vec<u8>>, WalletError> {
        let transaction = self.client.decode(&WireMessage::parse(message)?)?;
        let verified = self.client.verify(&transaction)?;
        let built = self.built.lock().map_err(|_| WalletError::failed("wallet", "the record of spends is poisoned"))?;
        let pool = Address(pool_program().to_bytes());

        review(&Review { verified: &verified, instructions: &transaction.instructions, pool, accepted, built: &built })
    }

    fn forget(&self, spent: &[Vec<u8>]) -> Result<(), WalletError> {
        let mut built = self.built.lock().map_err(|_| WalletError::failed("wallet", "the record of spends is poisoned"))?;
        spent.iter().for_each(|key| {
            built.remove(key);
        });

        Ok(())
    }
}

/// What the wallet reviews before it signs.
struct Review<'r> {
    verified: &'r VerifiedTransaction,
    instructions: &'r [Instruction],
    pool: Address,
    accepted: &'r [usize],
    built: &'r HashMap<Vec<u8>, ShieldedSpend>,
}

/// Every instruction is proven, or accepted by the caller, and every pool instruction is a spend
/// that the wallet built from the statement that its segment requires.
fn review(review: &Review<'_>) -> Result<Vec<Vec<u8>>, WalletError> {
    if review.verified.unverified != review.accepted {
        return Err(WalletError::refused(
            "unverified",
            format!(
                "no segment proves instructions {:?}, and the caller accepted {:?}",
                review.verified.unverified, review.accepted
            ),
        ));
    }

    review
        .instructions
        .iter()
        .enumerate()
        .filter(|(_, instruction)| instruction.program == review.pool)
        .map(|(position, instruction)| review_spend(review, position, instruction))
        .collect()
}

fn review_spend(review: &Review<'_>, position: usize, instruction: &Instruction) -> Result<Vec<u8>, WalletError> {
    let required = review
        .verified
        .intents
        .iter()
        .find(|intent| intent.built.contains(&position))
        .and_then(|intent| intent.spend.as_ref())
        .ok_or_else(|| {
            WalletError::refused(
                "unverifiedSpend",
                format!("instruction {position} spends from the pool, and no intent of the transaction says what it must do"),
            )
        })?;
    let key = fingerprint(instruction);
    let recorded = review.built.get(&key).ok_or_else(|| {
        WalletError::refused("unknownSpend", format!("the wallet did not build the spend at instruction {position}"))
    })?;

    if recorded != required {
        return Err(WalletError::refused(
            "wrongStatement",
            format!("the spend at instruction {position} does not do what its intent requires"),
        ));
    }

    Ok(key)
}

/// The positions of `unverified` in the body, in order. None means none.
fn accepted_unverified(body: &Value) -> Result<Vec<usize>, WalletError> {
    let Some(listed) = body.get("unverified") else {
        return Ok(Vec::new());
    };

    listed
        .as_array()
        .ok_or_else(|| WalletError::invalid_request("`unverified` is a list of instruction positions"))?
        .iter()
        .map(|position| {
            position
                .as_u64()
                .and_then(|position| usize::try_from(position).ok())
                .ok_or_else(|| WalletError::invalid_request("`unverified` is a list of instruction positions"))
        })
        .collect()
}

/// The provider's signatures that a plan of a provider's transaction holds, as `presigned`.
fn presigned(body: &Value) -> Result<Vec<ProviderSignature>, WalletError> {
    let listed = body.get("presigned").and_then(Value::as_array).cloned().unwrap_or_default();

    listed
        .iter()
        .map(|entry| {
            let decode =
                |key: &str| entry.get(key).and_then(Value::as_str).and_then(|text| bs58::decode(text).into_vec().ok());
            let signer = decode("address").and_then(|bytes| <[u8; 32]>::try_from(bytes).ok());
            let signature = decode("signature").and_then(|bytes| <[u8; 64]>::try_from(bytes).ok());

            match (signer, signature) {
                (Some(signer), Some(signature)) => Ok(ProviderSignature { signer: Address(signer), signature }),
                _ => Err(WalletError::invalid_request("each `presigned` entry has a base58 address and signature")),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use sdp_intents_planner::{AccountMeta, ShieldedCircuit, ShieldedNote, VerifiedIntent};
    use sdp_intents_spec::wire::DocumentIdV1;
    use sdp_intents_spec::{AccountRole, ShieldedProtocol};

    use super::*;

    const POOL: Address = Address([9; 32]);
    const SPENDER: Address = Address([1; 32]);
    const OTHER_KEY: Address = Address([2; 32]);

    fn spend(amount: u64) -> ShieldedSpend {
        ShieldedSpend {
            protocol: ShieldedProtocol::PrivacyRings,
            circuit: ShieldedCircuit { id: DocumentIdV1::default(), name: "circuit".into(), proving_keys: [7; 32] },
            spender: SPENDER,
            notes: vec![ShieldedNote { owner: OTHER_KEY, asset: Address([0; 32]), amount, data: Vec::new() }],
            deposits: Vec::new(),
            withdrawals: Vec::new(),
        }
    }

    fn pool_instruction(signer: Address) -> Instruction {
        Instruction {
            program: POOL,
            accounts: vec![AccountMeta { address: signer, role: AccountRole::WritableSigner }],
            data: vec![1, 2, 3],
        }
    }

    fn transfer() -> Instruction {
        Instruction { program: Address([0; 32]), accounts: Vec::new(), data: vec![2, 0, 0, 0] }
    }

    /// The pool instruction at position 1 sits in a shielded segment of instructions 0 to 3.
    fn verified(unverified: Vec<usize>, required: Option<ShieldedSpend>) -> VerifiedTransaction {
        let intent = VerifiedIntent { verify: 0, built: 1..2, segment: 0..3, spend: required };

        VerifiedTransaction { message: String::new(), intents: vec![intent], unverified }
    }

    fn reviewed(
        verified: &VerifiedTransaction,
        instructions: &[Instruction],
        accepted: &[usize],
        built: &HashMap<Vec<u8>, ShieldedSpend>,
    ) -> Result<Vec<Vec<u8>>, String> {
        review(&Review { verified, instructions, pool: POOL, accepted, built }).map_err(|error| error.code.to_owned())
    }

    fn built_with(instruction: &Instruction, spend: ShieldedSpend) -> HashMap<Vec<u8>, ShieldedSpend> {
        HashMap::from([(fingerprint(instruction), spend)])
    }

    #[test]
    fn signs_a_spend_that_it_built_from_the_required_statement() {
        let instructions = [transfer(), pool_instruction(SPENDER), transfer()];
        let built = built_with(&instructions[1], spend(5));

        let signed = reviewed(&verified(Vec::new(), Some(spend(5))), &instructions, &[], &built);

        assert_eq!(signed, Ok(vec![fingerprint(&instructions[1])]));
    }

    /// A transaction with no pool instruction still passes the verifier, so an instruction that no
    /// segment proves is refused.
    #[test]
    fn refuses_an_instruction_that_no_segment_proves() {
        let instructions = [transfer(), transfer(), transfer(), transfer()];

        let refused = reviewed(&verified(vec![3], None), &instructions, &[], &HashMap::new());

        assert_eq!(refused, Err("unverified".to_owned()));
    }

    #[test]
    fn signs_unverified_instructions_only_when_the_caller_lists_exactly_them() {
        let instructions = [transfer(), transfer(), transfer(), transfer(), transfer()];

        assert_eq!(reviewed(&verified(vec![3, 4], None), &instructions, &[3, 4], &HashMap::new()), Ok(Vec::new()));
        assert_eq!(
            reviewed(&verified(vec![3, 4], None), &instructions, &[3], &HashMap::new()),
            Err("unverified".to_owned())
        );
    }

    #[test]
    fn refuses_a_pool_instruction_outside_a_shielded_segment() {
        let instructions = [transfer(), pool_instruction(SPENDER), transfer()];
        let built = built_with(&instructions[1], spend(5));

        assert_eq!(reviewed(&verified(Vec::new(), None), &instructions, &[], &built), Err("unverifiedSpend".to_owned()));
    }

    /// The same data with another signer is another instruction, such as a deposit from another key.
    #[test]
    fn refuses_a_built_spend_whose_accounts_changed() {
        let instructions = [transfer(), pool_instruction(OTHER_KEY), transfer()];
        let built = built_with(&pool_instruction(SPENDER), spend(5));

        assert_eq!(
            reviewed(&verified(Vec::new(), Some(spend(5))), &instructions, &[], &built),
            Err("unknownSpend".to_owned())
        );
    }

    #[test]
    fn refuses_a_spend_built_from_another_statement() {
        let instructions = [transfer(), pool_instruction(SPENDER), transfer()];
        let built = built_with(&instructions[1], spend(5));

        assert_eq!(
            reviewed(&verified(Vec::new(), Some(spend(6))), &instructions, &[], &built),
            Err("wrongStatement".to_owned())
        );
    }
}
