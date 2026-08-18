//! Structural request validation and immutable stage hashing.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use zeroize::Zeroizing;

use crate::domain::sensitive::SensitiveJson;
use crate::error::ServiceError;
use crate::wire::api::{
    CreateWalletRequest, OperationStage, PlanRequest, ProveRequest, RotateWalletRequest,
    StageEnvelope, SyncRequest,
};

const MAX_ID_BYTES: usize = 128;
const MAX_PINNED_INPUTS: usize = 8;
const MAX_I_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Structural validation required before authorization.
pub trait Validate {
    /// Rejects malformed or stage-inconsistent input.
    fn validate(&self) -> Result<(), ServiceError>;
}

/// A request whose complete immutable content is bound to its stage token.
pub trait StageRequest: Validate {
    /// Returns the claims supplied to the stage authorizer.
    fn envelope(&self) -> &StageEnvelope;

    /// Computes `sha256:<lowercase hex>` over the canonical stage content.
    ///
    /// `requestId` is intentionally excluded so an exact retry may use a new
    /// correlation ID. All fields that can change protocol behavior are included.
    fn canonical_hash(&self) -> Result<String, ServiceError>;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalStage<'a, T: Serialize> {
    organization_id: &'a str,
    wallet_id: &'a str,
    operation_id: &'a str,
    stage: OperationStage,
    owner: &'a str,
    payload: T,
}

#[derive(Serialize)]
struct EmptyPayload {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncPayload<'a> {
    wallet_projection: Option<&'a Value>,
    require_slot: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanPayload<'a> {
    wallet_projection: Option<&'a Value>,
    require_slot: Option<u64>,
    action: &'a Value,
    fee_payer: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProvePayload<'a> {
    wallet_projection: Option<&'a Value>,
    require_slot: Option<u64>,
    action: &'a Value,
    fee_payer: &'a str,
    pinned_inputs: &'a [String],
    cu_limit: Option<u32>,
    cu_price_micro_lamports: Option<u64>,
}

fn hash_stage<T: Serialize>(envelope: &StageEnvelope, payload: T) -> Result<String, ServiceError> {
    let canonical = CanonicalStage {
        organization_id: &envelope.organization_id,
        wallet_id: &envelope.wallet_id,
        operation_id: &envelope.operation_id,
        stage: envelope.stage,
        owner: &envelope.owner,
        payload,
    };
    // RFC 8785 JCS is the cross-language contract. SDP can reproduce it in
    // TypeScript before issuing a stage token; ordinary JSON serialization is
    // not stable across Rust and JavaScript for object order or numeric forms.
    let bytes = Zeroizing::new(
        serde_json_canonicalizer::to_vec(&canonical).map_err(|_| ServiceError::internal())?,
    );
    let digest = Sha256::digest(bytes.as_slice());
    let mut encoded = String::with_capacity(7 + digest.len() * 2);
    encoded.push_str("sha256:");
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").map_err(|_| ServiceError::internal())?;
    }
    Ok(encoded)
}

fn validate_stage<R: StageRequest>(
    request: &R,
    expected_stage: OperationStage,
) -> Result<(), ServiceError> {
    let envelope = request.envelope();
    validate_id(&envelope.request_id)?;
    validate_id(&envelope.organization_id)?;
    validate_id(&envelope.wallet_id)?;
    validate_id(&envelope.operation_id)?;
    if envelope.stage != expected_stage {
        return Err(ServiceError::invalid_request());
    }
    validate_hash(&envelope.immutable_hash)?;
    validate_base58(&envelope.owner)?;
    if envelope.immutable_hash != request.canonical_hash()? {
        return Err(ServiceError::invalid_request());
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), ServiceError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(ServiceError::invalid_request());
    }
    Ok(())
}

fn validate_hash(value: &str) -> Result<(), ServiceError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(ServiceError::invalid_request());
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ServiceError::invalid_request());
    }
    Ok(())
}

fn validate_base58(value: &str) -> Result<(), ServiceError> {
    let mut decoded = [0u8; 32];
    let decoded_len = bs58::decode(value)
        .onto(&mut decoded)
        .map_err(|_| ServiceError::invalid_request())?;
    if decoded_len != decoded.len() {
        return Err(ServiceError::invalid_request());
    }
    Ok(())
}

fn validate_projection(projection: Option<&SensitiveJson>) -> Result<(), ServiceError> {
    if projection.is_some_and(|value| !value.expose().is_object()) {
        return Err(ServiceError::invalid_request());
    }
    if let Some(projection) = projection {
        validate_json_numbers(projection.expose())?;
    }
    Ok(())
}

fn validate_safe_u64(value: Option<u64>) -> Result<(), ServiceError> {
    if value.is_some_and(|value| value > MAX_I_JSON_SAFE_INTEGER) {
        return Err(ServiceError::invalid_request());
    }
    Ok(())
}

fn validate_json_numbers(value: &Value) -> Result<(), ServiceError> {
    match value {
        Value::Number(number) => {
            if number
                .as_f64()
                .is_none_or(|value| value.abs() > MAX_I_JSON_SAFE_INTEGER as f64)
            {
                return Err(ServiceError::invalid_request());
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_json_numbers(value)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                validate_json_numbers(value)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
    Ok(())
}

fn validate_commitment(value: &str) -> Result<(), ServiceError> {
    let mut decoded = [0u8; 32];
    let decoded_len = STANDARD
        .decode_slice(value, &mut decoded)
        .map_err(|_| ServiceError::invalid_request())?;
    if decoded_len != decoded.len() {
        return Err(ServiceError::invalid_request());
    }
    Ok(())
}

impl StageRequest for CreateWalletRequest {
    fn envelope(&self) -> &StageEnvelope {
        &self.envelope
    }

    fn canonical_hash(&self) -> Result<String, ServiceError> {
        hash_stage(&self.envelope, EmptyPayload {})
    }
}

impl Validate for CreateWalletRequest {
    fn validate(&self) -> Result<(), ServiceError> {
        validate_stage(self, OperationStage::Provision)
    }
}

impl StageRequest for RotateWalletRequest {
    fn envelope(&self) -> &StageEnvelope {
        &self.envelope
    }

    fn canonical_hash(&self) -> Result<String, ServiceError> {
        hash_stage(&self.envelope, EmptyPayload {})
    }
}

impl Validate for RotateWalletRequest {
    fn validate(&self) -> Result<(), ServiceError> {
        validate_stage(self, OperationStage::Rotate)
    }
}

impl StageRequest for SyncRequest {
    fn envelope(&self) -> &StageEnvelope {
        &self.envelope
    }

    fn canonical_hash(&self) -> Result<String, ServiceError> {
        hash_stage(
            &self.envelope,
            SyncPayload {
                wallet_projection: self.wallet_projection.as_ref().map(SensitiveJson::expose),
                require_slot: self.require_slot,
            },
        )
    }
}

impl Validate for SyncRequest {
    fn validate(&self) -> Result<(), ServiceError> {
        validate_projection(self.wallet_projection.as_ref())?;
        validate_safe_u64(self.require_slot)?;
        validate_stage(self, OperationStage::Sync)
    }
}

impl StageRequest for PlanRequest {
    fn envelope(&self) -> &StageEnvelope {
        &self.envelope
    }

    fn canonical_hash(&self) -> Result<String, ServiceError> {
        hash_stage(
            &self.envelope,
            PlanPayload {
                wallet_projection: self.wallet_projection.as_ref().map(SensitiveJson::expose),
                require_slot: self.require_slot,
                action: &self.action,
                fee_payer: &self.fee_payer,
            },
        )
    }
}

impl Validate for PlanRequest {
    fn validate(&self) -> Result<(), ServiceError> {
        validate_projection(self.wallet_projection.as_ref())?;
        if !self.action.is_object() {
            return Err(ServiceError::invalid_request());
        }
        validate_json_numbers(&self.action)?;
        validate_safe_u64(self.require_slot)?;
        validate_base58(&self.fee_payer)?;
        validate_stage(self, OperationStage::Plan)
    }
}

impl StageRequest for ProveRequest {
    fn envelope(&self) -> &StageEnvelope {
        &self.envelope
    }

    fn canonical_hash(&self) -> Result<String, ServiceError> {
        hash_stage(
            &self.envelope,
            ProvePayload {
                wallet_projection: self.wallet_projection.as_ref().map(SensitiveJson::expose),
                require_slot: self.require_slot,
                action: &self.action,
                fee_payer: &self.fee_payer,
                pinned_inputs: &self.pinned_inputs,
                cu_limit: self.cu_limit,
                cu_price_micro_lamports: self.cu_price_micro_lamports,
            },
        )
    }
}

impl Validate for ProveRequest {
    fn validate(&self) -> Result<(), ServiceError> {
        validate_projection(self.wallet_projection.as_ref())?;
        if !self.action.is_object()
            || self.pinned_inputs.is_empty()
            || self.pinned_inputs.len() > MAX_PINNED_INPUTS
            || self
                .pinned_inputs
                .iter()
                .any(|value| value.is_empty() || value.len() > 256)
        {
            return Err(ServiceError::invalid_request());
        }
        for commitment in &self.pinned_inputs {
            validate_commitment(commitment)?;
        }
        validate_json_numbers(&self.action)?;
        validate_safe_u64(self.require_slot)?;
        validate_safe_u64(self.cu_price_micro_lamports)?;
        validate_base58(&self.fee_payer)?;
        validate_stage(self, OperationStage::Prove)
    }
}
