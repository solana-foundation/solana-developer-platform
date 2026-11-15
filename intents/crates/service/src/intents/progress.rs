//! `progress`: the record of a flow that the chain cannot show (`DESIGN.md`, 4.19). The caller stores
//! the latest one and sends it back unchanged.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ServiceError;

pub const VERSION: u8 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Progress {
    pub v: u8,
    pub request: Value,
    /// Exact ids, such as `solana.org/privacy-rings-shield@1.0.0`, read when the flow started.
    pub pins: Vec<String>,
    #[serde(default)]
    pub steps: BTreeMap<String, StepRecord>,
    /// The caller asked to stop the flow. It stops once no planned step can still land.
    #[serde(default, skip_serializing_if = "core::ops::Not::not")]
    pub stopping: bool,
    /// How many steps had landed when the flow stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StepRecord {
    #[serde(default, skip_serializing_if = "StepFacts::is_empty")]
    pub plan: StepFacts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned: Option<PlannedStep>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepFacts {
    /// The accounts that the pool creates for the step's nullifiers, in base58, which a `spent`
    /// condition reads.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nullifier_accounts: Vec<String>,
}

/// A step's transaction until it lands or expires. `continue` returns the same step meanwhile, so
/// that a second signature signs the same bytes.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedStep {
    pub step: Value,
    /// Absent for a plan of instructions alone, which the caller compiles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<Expiry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub signatures: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expiry {
    pub block_height: u64,
}

impl StepFacts {
    fn is_empty(&self) -> bool {
        self.nullifier_accounts.is_empty()
    }
}

impl Progress {
    pub fn read(value: Option<&Value>) -> Result<Self, ServiceError> {
        let value = value.ok_or_else(|| ServiceError::invalid_request("the body holds `progress`"))?;
        let progress: Self = serde_json::from_value(value.clone())
            .map_err(|error| ServiceError::invalid_request(format!("`progress` does not parse: {error}")))?;

        if progress.v != VERSION {
            return Err(ServiceError::invalid_request(format!("`progress` is version {}, not {VERSION}", progress.v)));
        }

        Ok(progress)
    }

    /// The exact id that the flow pinned for `id`, such as `solana.org/privacy-rings-shield`.
    pub fn pinned(&self, id: &str) -> Option<&str> {
        self.pins.iter().map(String::as_str).find(|pin| pin.split_once('@').is_some_and(|(pinned, _)| pinned == id))
    }

    pub fn step(&mut self, name: &str) -> &mut StepRecord {
        self.steps.entry(name.to_owned()).or_default()
    }

    pub fn json(&self) -> Result<Value, ServiceError> {
        serde_json::to_value(self).map_err(ServiceError::from)
    }
}
