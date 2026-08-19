//! SDP-to-key-authority API contract.
//!
//! Stage tokens are carried in `Authorization: Bearer ...`; they are never part
//! of a serializable request or response value.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::domain::sensitive::SensitiveJson;

/// Authorized operation stage.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationStage {
    /// Initial wallet provisioning.
    Provision,
    /// Append a viewing-key generation.
    Rotate,
    /// Refresh private wallet state.
    Sync,
    /// Select and pin transaction inputs.
    Plan,
    /// Build a witness and request a proof.
    Prove,
}

/// Immutable claims bound to one stage token.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageEnvelope {
    /// Correlation ID shared across logs.
    pub request_id: String,
    /// Tenant boundary.
    pub organization_id: String,
    /// Stable SDP Rings wallet ID.
    pub wallet_id: String,
    /// Durable operation ID.
    pub operation_id: String,
    /// Requested stage.
    pub stage: OperationStage,
    /// Hash of the immutable stage input.
    pub immutable_hash: String,
    /// Public Ed25519 owner address.
    pub owner: String,
}

/// `POST /v1/wallets`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWalletRequest {
    /// Provision-stage claims.
    pub envelope: StageEnvelope,
}

/// `POST /v1/wallets/{walletId}/rotate`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotateWalletRequest {
    /// Rotation-stage claims.
    pub envelope: StageEnvelope,
}

/// `POST /v1/wallets/sync`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncRequest {
    /// Sync-stage claims.
    pub envelope: StageEnvelope,
    /// Encrypted-at-rest wallet projection decrypted by SDP for this request.
    pub wallet_projection: Option<SensitiveJson>,
    /// Minimum Photon slot required for read-your-writes.
    pub require_slot: Option<u64>,
}

/// `POST /v1/operations/plan`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRequest {
    /// Plan-stage claims.
    pub envelope: StageEnvelope,
    /// Current wallet projection.
    pub wallet_projection: Option<SensitiveJson>,
    /// Minimum Photon slot.
    pub require_slot: Option<u64>,
    /// Sidecar action specification, kept opaque to this custody service.
    pub action: Value,
    /// Public transaction fee payer.
    pub fee_payer: String,
}

/// `POST /v1/operations/prove`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProveRequest {
    /// Prove-stage claims.
    pub envelope: StageEnvelope,
    /// Wallet projection used to reconstruct the witness.
    pub wallet_projection: Option<SensitiveJson>,
    /// Minimum Photon slot.
    pub require_slot: Option<u64>,
    /// Action approved after planning.
    pub action: Value,
    /// Fee payer committed during planning.
    pub fee_payer: String,
    /// Ordered commitment hashes selected by planning.
    pub pinned_inputs: Vec<String>,
    /// Optional compute-unit limit.
    pub cu_limit: Option<u32>,
    /// Optional compute-unit price in micro-lamports.
    pub cu_price_micro_lamports: Option<u64>,
}

/// Public wallet identity returned after provisioning.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletPublicMaterial {
    /// Stable SDP Rings wallet ID.
    pub wallet_id: String,
    /// Public shielded address.
    pub shielded_address: String,
    /// Public P-256 viewing-key generations.
    pub viewing_public_keys: Vec<IndexedPublicViewingKey>,
    /// Public half derived from the nullifier secret.
    pub nullifier_public_key: String,
}

/// Public P-256 key and its append-only generation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedPublicViewingKey {
    /// Stable append-only generation.
    pub index: u32,
    /// Encoded P-256 public key.
    pub public_key: String,
}

/// Provisioning response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWalletResponse {
    /// Public identity; no private key bytes.
    pub wallet: WalletPublicMaterial,
}

/// Viewing-key rotation response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateWalletResponse {
    /// Stable wallet ID.
    pub wallet_id: String,
    /// Newly appended public viewing key.
    pub viewing_public_key: IndexedPublicViewingKey,
}
