//! Signs and sends. Before it signs, the wallet checks each spend from the Privacy Rings pool: the
//! spend must sit in a shielded segment whose intent the verifier reads from the transaction, and
//! must be one that the wallet built, with the notes that the intent requires. The notes are
//! hidden onchain, so the key holder is the one party that can check them.

use base64::Engine as _;
use serde_json::{json, Value};

use sdp_intents_client::message::WireMessage;
use sdp_intents_planner::ProviderSignature;
use sdp_intents_privacy_rings::pool_program;
use sdp_intents_spec::Address;

use crate::error::WalletError;
use crate::Wallet;

impl Wallet {
    /// A body of `{ "message": base64, "presigned": [...] }`: checks the spends, signs with each key
    /// that the message requires, and sends.
    pub fn send(&self, body: &Value) -> Result<Value, WalletError> {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .map(|text| base64::engine::general_purpose::STANDARD.decode(text))
            .ok_or_else(|| WalletError::invalid_request("the body holds `message`, a base64 message"))?
            .map_err(|error| WalletError::invalid_request(format!("`message` is not base64: {error}")))?;

        self.check_spends(&message)?;

        let signature = self.client.send_presigned(&message, &self.keys.keypairs(), &presigned(body)?)?;

        Ok(json!({ "signature": signature.to_string() }))
    }

    fn check_spends(&self, message: &[u8]) -> Result<(), WalletError> {
        let transaction = self.client.decode(&WireMessage::parse(message)?)?;
        let pool = Address(pool_program().to_bytes());
        let spends: Vec<usize> = (0..transaction.instructions.len())
            .filter(|position| transaction.instructions.get(*position).is_some_and(|ix| ix.program == pool))
            .collect();

        if spends.is_empty() {
            return Ok(());
        }

        let verified = self.client.verify(&transaction)?;
        let built = self.built.lock().map_err(|_| WalletError::failed("wallet", "the record of spends is poisoned"))?;

        spends.into_iter().try_for_each(|position| {
            let required = verified
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
            let data = transaction.instructions.get(position).map(|spend| &spend.data);
            let recorded = data.and_then(|data| built.get(data)).ok_or_else(|| {
                WalletError::refused("unknownSpend", format!("the wallet did not build the spend at instruction {position}"))
            })?;

            if recorded != required {
                return Err(WalletError::refused(
                    "wrongStatement",
                    format!("the spend at instruction {position} does not do what its intent requires"),
                ));
            }

            Ok(())
        })
    }
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
