//! The JSON form of a remote recipe's call (`DESIGN.md`, 4.16), and the call over HTTP.
//!
//! The request holds the interface, the implementation, each input by name, and the payers. An
//! address is base58, an integer is a decimal string in base units, and absent is `null`. The
//! answer holds the instructions in the plan's instruction shape, and the outputs that the record
//! leaves unbound.

use base64::Engine as _;
use serde_json::{json, Map, Value};

use sdp_intents_planner::{AccountMeta, InputValue, Instruction, RemoteAnswer, RemoteCall, RemoteOutput};
use sdp_intents_spec::{AccountRole, Address};

use crate::json::base58;
use crate::{Client, ClientError};

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
    })
}

pub fn read_answer(answer: &Value) -> Result<RemoteAnswer, ClientError> {
    let error = |message: &str| ClientError::Remote(format!("the endpoint's answer {message}"));

    if answer.get("kind").and_then(Value::as_str) != Some("instructions") {
        return Err(error("is not `{ \"kind\": \"instructions\" }`"));
    }

    let instructions = answer
        .get("instructions")
        .and_then(Value::as_array)
        .ok_or_else(|| error("has no instructions"))?
        .iter()
        .map(instruction)
        .collect::<Result<Vec<_>, _>>()?;
    let outputs = answer
        .get("outputs")
        .and_then(Value::as_object)
        .map(|outputs| {
            outputs
                .iter()
                .map(|(name, address)| Ok(RemoteOutput { name: name.clone(), address: parse_address(address)? }))
                .collect::<Result<Vec<_>, ClientError>>()
        })
        .transpose()?
        .unwrap_or_default();

    Ok(RemoteAnswer { instructions, outputs })
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

        answered(status.as_u16(), &answer)
    }
}

/// The answer, or the endpoint's `error` when its status is not a success.
pub fn answered(status: u16, answer: &Value) -> Result<RemoteAnswer, ClientError> {
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
fn instruction(value: &Value) -> Result<Instruction, ClientError> {
    let error = |message: &str| ClientError::Remote(format!("an instruction of the endpoint {message}"));
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

        let read = read_answer(&answer).unwrap();

        assert_eq!(read.instructions, [instruction]);
        assert_eq!(read.outputs, [RemoteOutput { name: "shareMint".into(), address: program }]);
    }

    #[test]
    fn refuses_a_transaction_answer() {
        assert!(read_answer(&json!({ "kind": "transaction", "transaction": "" })).is_err());
    }
}
