//! Sidecar-facing request contract derived from PR 1289.
//!
//! Secret serialization is deliberately confined to this module. The domain
//! secret types themselves are not serializable.

use base64::Engine as _;
use serde::{Deserialize, Serialize, Serializer, ser::SerializeStruct as _};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::domain::keys::{KeyMaterial, SecretBytes};
use crate::domain::sensitive::SensitiveString;

/// Shared sidecar preamble with key material injected by this service.
pub struct GatewayPreamble<'a> {
    request_id: &'a str,
    owner: &'a str,
    key_material: &'a KeyMaterial,
    wallet_projection: Option<&'a Value>,
    require_slot: Option<u64>,
}

impl<'a> GatewayPreamble<'a> {
    /// Constructs a sidecar preamble at the only key-release boundary.
    pub const fn new(
        request_id: &'a str,
        owner: &'a str,
        key_material: &'a KeyMaterial,
        wallet_projection: Option<&'a Value>,
        require_slot: Option<u64>,
    ) -> Self {
        Self {
            request_id,
            owner,
            key_material,
            wallet_projection,
            require_slot,
        }
    }
}

impl Serialize for GatewayPreamble<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut value = serializer.serialize_struct("Preamble", 5)?;
        value.serialize_field("requestId", self.request_id)?;
        value.serialize_field("owner", self.owner)?;
        value.serialize_field("keyMaterial", &GatewayKeyMaterial(self.key_material))?;
        value.serialize_field("walletProjection", &self.wallet_projection)?;
        value.serialize_field("requireSlot", &self.require_slot)?;
        value.end()
    }
}

/// Sidecar `POST /v1/wallets/sync` request.
#[derive(Serialize)]
pub struct GatewaySyncRequest<'a> {
    /// Shared preamble.
    pub preamble: GatewayPreamble<'a>,
}

/// Sidecar `POST /v1/operations/plan` request.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayPlanRequest<'a> {
    /// Shared preamble.
    pub preamble: GatewayPreamble<'a>,
    /// Opaque action specification received from SDP.
    pub action: &'a Value,
    /// Public fee payer committed by the circuit.
    pub fee_payer: &'a str,
}

/// Sidecar `POST /v1/operations/prove` request.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayProveRequest<'a> {
    /// Shared preamble.
    pub preamble: GatewayPreamble<'a>,
    /// Approved action specification.
    pub action: &'a Value,
    /// Approved fee payer.
    pub fee_payer: &'a str,
    /// Ordered commitment hashes selected at plan time.
    pub pinned_inputs: &'a [String],
    /// Optional compute-unit limit.
    pub cu_limit: Option<u32>,
    /// Optional compute-unit price in micro-lamports.
    pub cu_price_micro_lamports: Option<u64>,
}

/// Typed sidecar sync response.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewaySyncResponse {
    /// Private balances by asset.
    pub balances: Vec<GatewayAssetBalance>,
    /// Decrypted private history.
    pub transactions: Vec<GatewayPrivateTransaction>,
    /// Updated secret-bearing wallet projection.
    pub projection: GatewayWalletProjection,
    /// Indexing completeness report.
    pub sync_report: GatewaySyncReport,
    /// Photon slot used for this response.
    pub slot: u64,
}

/// Exact PR 1289 wallet projection schema.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayWalletProjection {
    /// Projection schema version.
    pub version: u32,
    /// Per-viewing-key tag counters.
    pub tag_counters: Vec<GatewayViewingKeyCounter>,
    /// Known spent and unspent notes.
    pub utxos: Vec<GatewayProjectedUtxo>,
}

impl std::fmt::Debug for GatewayWalletProjection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("GatewayWalletProjection([redacted])")
    }
}

/// One viewing generation's observed transaction count.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayViewingKeyCounter {
    /// Stable viewing-key generation.
    pub viewing_key_index: u32,
    /// Decimal transaction count.
    pub tx_count: SensitiveString,
}

/// One projected private note.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayProjectedUtxo {
    /// Note commitment.
    pub utxo_hash: SensitiveString,
    /// Mint or SOL sentinel.
    pub asset: SensitiveString,
    /// Decimal base-unit amount.
    pub amount: SensitiveString,
    /// Secret note blinding.
    pub blinding: SensitiveString,
    /// Whether the note has been observed spent.
    pub spent: bool,
}

/// One private asset balance.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayAssetBalance {
    /// Mint or SOL sentinel.
    pub asset: String,
    /// Base-unit amount encoded as a decimal string.
    pub amount: String,
    /// Number of backing notes.
    pub note_count: u32,
}

/// One decrypted private transaction.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayPrivateTransaction {
    /// On-chain signature.
    pub signature: String,
    /// Indexed slot.
    pub slot: u64,
    /// Mint or SOL sentinel.
    pub asset: String,
    /// Base-unit amount.
    pub amount: String,
    /// Direction relative to this wallet.
    pub direction: GatewayDirection,
    /// Output note commitments.
    pub output_utxo_hashes: Vec<String>,
}

/// Private transaction direction.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GatewayDirection {
    /// Value entered this wallet.
    Inbound,
    /// Value left this wallet.
    Outbound,
}

/// Sidecar sync completeness report.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewaySyncReport {
    /// Notes stored by this sync.
    pub stored_utxos: u64,
    /// Transactions that could not be parsed.
    pub unparsed_transactions: u64,
    /// Matching view tags that failed decryption.
    pub undecryptable_candidates: u64,
    /// Assets not found in the registry.
    pub unknown_asset_ids: Vec<String>,
    /// Whether a rejected projection forced a full rescan.
    pub full_rescan: bool,
}

/// Typed sidecar plan response.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayPlanResponse {
    /// Ordered selected inputs.
    pub inputs: Vec<GatewayPlannedInput>,
    /// Required custody signers excluding fee payer.
    pub owner_signers: Vec<String>,
    /// Selected circuit shape.
    pub shape: GatewayCircuitShape,
    /// Fee payer committed by the circuit.
    pub fee_payer: String,
    /// Approval-safe summary.
    pub summary: String,
    /// Estimated base-unit amount.
    pub total_amount: String,
    /// Sync completeness report.
    pub sync_report: GatewaySyncReport,
}

/// One selected note.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayPlannedInput {
    /// Circuit input position.
    pub index: u32,
    /// Note commitment.
    pub utxo_hash: String,
    /// Derived nullifier.
    pub nullifier: String,
    /// Base-unit amount.
    pub amount: String,
}

/// Supported circuit dimensions.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayCircuitShape {
    /// Input count.
    pub n_in: u8,
    /// Output count.
    pub n_out: u8,
}

/// Typed sidecar prove response.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayProveResponse {
    /// Serialized transact instruction data.
    pub transact_ix_data: String,
    /// Input tree account.
    pub input_tree: String,
    /// Output tree account.
    pub output_tree: String,
    /// Required custody signers excluding fee payer.
    pub owner_signers: Vec<String>,
    /// Published nullifiers.
    pub nullifiers: Vec<String>,
    /// Prover wall-clock duration.
    pub proof_duration_ms: u64,
}

struct GatewayKeyMaterial<'a>(&'a KeyMaterial);

impl Serialize for GatewayKeyMaterial<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut value = serializer.serialize_struct("KeyMaterial", 2)?;
        let viewing_keys = self
            .0
            .viewing_keys()
            .iter()
            .map(GatewayIndexedViewingKey)
            .collect::<Vec<_>>();
        value.serialize_field("viewingKeys", &viewing_keys)?;
        value.serialize_field("nullifierKey", &GatewaySecret(self.0.nullifier_key()))?;
        value.end()
    }
}

struct GatewayIndexedViewingKey<'a>(&'a crate::domain::keys::IndexedViewingKey);

impl Serialize for GatewayIndexedViewingKey<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut value = serializer.serialize_struct("IndexedViewingKey", 2)?;
        value.serialize_field("index", &self.0.index())?;
        value.serialize_field("key", &GatewaySecret(self.0.key()))?;
        value.end()
    }
}

struct GatewaySecret<'a, const N: usize>(&'a SecretBytes<N>);

impl<const N: usize> Serialize for GatewaySecret<'_, N> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let encoded =
            Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(self.0.expose()));
        serializer.serialize_str(&encoded)
    }
}
