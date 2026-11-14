//! Whether a step's `ready` or `done` condition holds (`DESIGN.md`, 4.19). A condition is bound
//! first: each reference becomes its value, which is also what a `wait` returns as `until`.

use serde_json::{Map, Value};

use sdp_intents_chain::Freshness;
use sdp_intents_spec::Address;

use crate::error::ServiceError;
use crate::intents::flow::Bindings;
use crate::Service;

/// A condition with values in place of references, and its rendered message.
pub struct Bound {
    pub kind: String,
    pub body: Value,
    pub message: Option<String>,
}

impl Bound {
    pub fn new(condition: &Map<String, Value>, bindings: &Bindings<'_>) -> Result<Self, ServiceError> {
        let (kind, body) = condition
            .iter()
            .find(|(key, _)| key.as_str() != "message")
            .ok_or_else(|| ServiceError::refused("flow", "a condition names no kind"))?;
        let message = condition.get("message").and_then(Value::as_str).map(|template| bindings.render(template));

        Ok(Self { kind: kind.clone(), body: bindings.bind(body)?, message })
    }

    /// `{ "<kind>": <bound body> }`, which a `wait` returns as `until`.
    pub fn json(&self) -> Value {
        Value::Object(Map::from_iter([(self.kind.clone(), self.body.clone())]))
    }

    pub async fn holds(&self, service: &Service) -> Result<bool, ServiceError> {
        match self.kind.as_str() {
            "exists" => {
                let account = address(self.body.get("account"))?;
                let exists = self.body.get("exists").and_then(Value::as_bool).unwrap_or(true);
                let fetched = service.chain.accounts(&[account], Freshness::Live).await?;

                Ok(fetched.first().is_some_and(Option::is_some) == exists)
            }
            "privateBalance" => {
                let owner = address(self.body.get("owner"))?;
                let mint = address(self.body.get("mint"))?;
                let min = amount(self.body.get("min"))?;

                Ok(crate::shielded::private_balance(service, &owner, &mint).await? >= min)
            }
            "spent" => {
                let nullifiers = self
                    .body
                    .as_array()
                    .map(|listed| listed.iter().map(|nullifier| bytes32(Some(nullifier))).collect())
                    .unwrap_or_else(|| Ok(Vec::new()))?;

                Ok(!nullifiers.is_empty() && crate::shielded::spent(service, nullifiers).await?)
            }
            other => Err(ServiceError::refused("flow", format!("the service cannot check a `{other}` condition yet"))),
        }
    }
}

fn bytes32(value: Option<&Value>) -> Result<[u8; 32], ServiceError> {
    value
        .and_then(Value::as_str)
        .and_then(|text| bs58::decode(text).into_vec().ok())
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or_else(|| ServiceError::refused("flow", "a condition value is not a base58 address"))
}

fn address(value: Option<&Value>) -> Result<Address, ServiceError> {
    bytes32(value).map(Address)
}

fn amount(value: Option<&Value>) -> Result<u64, ServiceError> {
    value
        .and_then(Value::as_str)
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| ServiceError::refused("flow", "a condition amount is not a decimal integer"))
}
