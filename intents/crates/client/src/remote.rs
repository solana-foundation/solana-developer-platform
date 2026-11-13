//! The JSON form of a remote recipe's call (`DESIGN.md`, 4.16), and the call over HTTP.
//!
//! The request holds the interface, the implementation, each input by name, and the payers. An
//! address is base58, an integer is a decimal string in base units, and absent is `null`. The
//! answer holds the instructions in the plan's instruction shape, and the outputs that the implementation
//! leaves unbound, or a whole transaction that the provider signed, of any version.

use base64::Engine as _;
use serde_json::{json, Map, Value};

use sdp_intents_planner::{
    AccountMeta, FrozenTransaction, InputValue, Instruction, ProviderSignature, RemoteAnswer, RemoteCall, RemoteOutput,
};
use sdp_intents_spec::{AccountRole, Address};

use crate::json::base58;
use crate::message::{read_transaction, LookupTable, SignedMessage, WireMessage};
use crate::{Client, ClientError};

/// What an endpoint answered. A provider's transaction can name accounts through lookup tables, so
/// the planner reads it only after the caller fetches them.
#[derive(Clone, Debug)]
pub enum Answer {
    Instructions(RemoteAnswer),
    Transaction { signed: SignedMessage, outputs: Vec<RemoteOutput> },
}

impl Answer {
    pub fn lookup_tables(&self) -> Vec<Address> {
        match self {
            Self::Instructions(_) => Vec::new(),
            Self::Transaction { signed, .. } => signed.message.lookup_tables(),
        }
    }

    /// The answer for the planner. `tables` holds each table of [`Answer::lookup_tables`].
    pub fn read(self, tables: &[LookupTable]) -> Result<RemoteAnswer, ClientError> {
        match self {
            Self::Instructions(answer) => Ok(answer),
            Self::Transaction { signed, outputs } => {
                Ok(RemoteAnswer { instructions: Vec::new(), outputs, frozen: Some(frozen(&signed, tables)?) })
            }
        }
    }
}

/// An endpoint answers within this time, or the call fails. The Jupiter wrapper can wait about 30
/// seconds for its rate limit.
pub const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

pub fn request_body(call: &RemoteCall) -> Value {
    let inputs: Map<String, Value> =
        call.inputs.iter().map(|input| (input.name.clone(), input_json(&input.value))).collect();

    json!({
        "spec": "sdp-intents-remote@1",
        "interface": { "name": call.interface, "version": call.interface_version },
        "implementation": call.implementation,
        "inputs": inputs,
        "payers": { "fee": base58(&call.fee_payer), "rent": base58(&call.rent_payer) },
        "priorityFeeLamports": call.priority_fee_lamports.to_string(),
    })
}

pub fn read_answer(answer: &Value) -> Result<Answer, ClientError> {
    let error = |message: &str| ClientError::Remote(format!("the endpoint's answer {message}"));
    let outputs = outputs(answer)?;

    match answer.get("kind").and_then(Value::as_str) {
        Some("instructions") => {}
        Some("transaction") => {
            let transaction =
                answer.get("transaction").and_then(Value::as_str).ok_or_else(|| error("has no transaction"))?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(transaction)
                .map_err(|_| error("holds a transaction that is not base64"))?;

            let signed = read_transaction(&bytes)
                .map_err(|error| ClientError::Remote(format!("the provider's transaction does not decode: {error}")))?;

            return Ok(Answer::Transaction { signed, outputs });
        }
        _ => return Err(error("is not `{ \"kind\": \"instructions\" }` or `{ \"kind\": \"transaction\" }`")),
    }

    let instructions = answer
        .get("instructions")
        .and_then(Value::as_array)
        .ok_or_else(|| error("has no instructions"))?
        .iter()
        .map(instruction)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Answer::Instructions(RemoteAnswer { instructions, outputs, frozen: None }))
}

fn outputs(answer: &Value) -> Result<Vec<RemoteOutput>, ClientError> {
    let outputs = answer.get("outputs").and_then(Value::as_object);

    outputs
        .map(|outputs| {
            outputs
                .iter()
                .map(|(name, address)| Ok(RemoteOutput { name: name.clone(), address: parse_address(address)? }))
                .collect::<Result<Vec<_>, ClientError>>()
        })
        .transpose()
        .map(Option::unwrap_or_default)
}

/// A provider's transaction from its wire form. Each signature that is not empty must sign the
/// message, for the signer at its place.
pub fn frozen(signed: &SignedMessage, tables: &[LookupTable]) -> Result<FrozenTransaction, ClientError> {
    let signed_by = signed.message.signers().into_iter().zip(&signed.signatures);
    let signatures = signed_by
        .filter(|(_, signature)| **signature != [0; 64])
        .map(|(signer, signature)| ProviderSignature { signer, signature: *signature })
        .collect();

    frozen_from_parts(&signed.message, signatures, tables)
}

/// A provider's transaction from its message and its signatures, such as a plan holds them. Each
/// signature must sign the message for an account that the message requires.
pub fn frozen_from_parts(
    message: &WireMessage,
    signatures: Vec<ProviderSignature>,
    tables: &[LookupTable],
) -> Result<FrozenTransaction, ClientError> {
    let signers = message.signers();
    let checked = signatures.iter().all(|signed| {
        signers.contains(&signed.signer)
            && solana_signature::Signature::from(signed.signature).verify(&signed.signer.0, message.bytes())
    });

    if !checked {
        return Err(ClientError::Remote("a provider's signature does not sign the message for a signer of it".into()));
    }

    Ok(FrozenTransaction {
        message: message.bytes().to_vec(),
        transaction: message.decode(tables)?,
        lookup_tables: message.lookup_tables(),
        signatures,
    })
}

impl Client {
    pub(crate) fn call_remote(&self, call: &RemoteCall) -> Result<RemoteAnswer, ClientError> {
        let http = reqwest::blocking::Client::builder()
            .timeout(CALL_TIMEOUT)
            .build()
            .map_err(|error| ClientError::Remote(error.to_string()))?;
        let response = http
            .post(&call.url)
            .json(&request_body(call))
            .send()
            .map_err(|error| ClientError::Remote(error.to_string()))?;
        let status = response.status();
        let answer: Value = response.json().map_err(|error| ClientError::Remote(error.to_string()))?;
        let answer = answered(status.as_u16(), &answer)?;
        let tables = self.lookup_tables(&answer.lookup_tables())?;

        answer.read(&tables)
    }

    /// [`frozen_from_parts`] for a serialized message, with its lookup tables read over RPC.
    pub fn frozen(&self, message: &[u8], signatures: Vec<ProviderSignature>) -> Result<FrozenTransaction, ClientError> {
        let message = WireMessage::parse(message)?;
        let tables = self.lookup_tables(&message.lookup_tables())?;

        frozen_from_parts(&message, signatures, &tables)
    }
}

/// The answer, or the endpoint's `error` when its status is not a success.
pub fn answered(status: u16, answer: &Value) -> Result<Answer, ClientError> {
    if !(200..300).contains(&status) {
        let error = answer.get("error").and_then(Value::as_str).unwrap_or("no error message");

        return Err(ClientError::Remote(format!("the endpoint answered {status}: {error}")));
    }

    read_answer(answer)
}

fn input_json(value: &InputValue) -> Value {
    match value {
        InputValue::Absent => Value::Null,
        InputValue::Unsigned(integer) => Value::String(integer.to_string()),
        InputValue::Signed(integer) => Value::String(integer.to_string()),
        InputValue::Bool(flag) => Value::Bool(*flag),
        InputValue::Address(address) => Value::String(base58(address)),
        InputValue::Text(text) => Value::String(text.clone()),
        InputValue::Bytes(bytes) => Value::String(bytes.iter().map(|byte| format!("{byte:02x}")).collect()),
        InputValue::List(items) => Value::Array(items.iter().map(input_json).collect()),
    }
}

/// `{ "programAddress", "accounts": [{ "address", "role" }], "data": base64 }`, as a plan writes it.
pub fn instruction(value: &Value) -> Result<Instruction, ClientError> {
    let error = |message: &str| ClientError::Remote(format!("an instruction {message}"));
    let program = parse_address(value.get("programAddress").ok_or_else(|| error("has no `programAddress`"))?)?;
    let data = value.get("data").and_then(Value::as_str).ok_or_else(|| error("has no `data`")).and_then(|data| {
        base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| error("has data that is not base64"))
    })?;
    let accounts = value
        .get("accounts")
        .and_then(Value::as_array)
        .ok_or_else(|| error("has no `accounts`"))?
        .iter()
        .map(|meta| {
            let address = parse_address(meta.get("address").ok_or_else(|| error("names an account with no address"))?)?;
            let role = meta
                .get("role")
                .and_then(Value::as_u64)
                .and_then(|role| u8::try_from(role).ok())
                .and_then(|role| AccountRole::try_from(role).ok())
                .ok_or_else(|| error("names an account with no valid role"))?;

            Ok(AccountMeta { address, role })
        })
        .collect::<Result<Vec<_>, ClientError>>()?;

    Ok(Instruction { program, accounts, data })
}

fn parse_address(value: &Value) -> Result<Address, ClientError> {
    value
        .as_str()
        .and_then(|text| bs58::decode(text).into_vec().ok())
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .map(Address)
        .ok_or_else(|| ClientError::Remote(format!("`{value}` is not a base58 address")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An answer reads back to the instructions of the plan's shape.
    #[test]
    fn reads_an_answer_in_the_plan_shape() {
        let program = Address([3; 32]);
        let owner = Address([4; 32]);
        let instruction = Instruction {
            program,
            accounts: vec![AccountMeta { address: owner, role: AccountRole::WritableSigner }],
            data: vec![1, 2, 3],
        };
        let answer = json!({
            "kind": "instructions",
            "instructions": [crate::json::instruction(&instruction)],
            "outputs": { "shareMint": base58(&program) },
        });

        let Answer::Instructions(read) = read_answer(&answer).unwrap() else {
            panic!("the answer is not instructions")
        };

        assert_eq!(read.instructions, [instruction]);
        assert_eq!(read.outputs, [RemoteOutput { name: "shareMint".into(), address: program }]);
    }

    /// A provider's v1 transaction signed for its order account, with the payer's signature empty. A
    /// v1 transaction writes its signatures after the message.
    fn signed_by_provider(corrupt: bool) -> Vec<u8> {
        use solana_signer::Signer as _;

        let payer = Address([1; 32]);
        let order = solana_keypair::Keypair::new();
        let order_address = Address(order.pubkey().to_bytes());
        let create = Instruction {
            program: Address::default(),
            accounts: vec![
                AccountMeta { address: payer, role: AccountRole::WritableSigner },
                AccountMeta { address: order_address, role: AccountRole::WritableSigner },
            ],
            data: vec![0; 52],
        };
        let transaction = sdp_intents_planner::Transaction {
            fee_payer: payer,
            instructions: vec![create],
            budget: sdp_intents_planner::Budget::MAXIMUM,
            priority_fee_lamports: 0,
        };
        let message = crate::rpc::v1_message(&transaction, solana_hash::Hash::default()).unwrap().serialize();
        let mut signature = <[u8; 64]>::from(order.sign_message(&message));
        signature[0] ^= u8::from(corrupt);

        [&message[..], &[0; 64], &signature].concat()
    }

    #[test]
    fn reads_a_provider_transaction_and_checks_its_signature() {
        let read = |corrupt: bool| frozen(&read_transaction(&signed_by_provider(corrupt))?, &[]);
        let checked = read(false).unwrap();

        assert_eq!(checked.signatures.len(), 1);
        assert_eq!(checked.transaction.fee_payer, Address([1; 32]));
        assert!(read(true).is_err());
    }
}
