//! `POST /v1/operations/plan` — select inputs and describe the operation.
//!
//! Does **not** prove. Planning is cheap and its output is what SDP persists
//! before asking for approval, so that the approved operation and the proved
//! operation provably spend the same notes.

use serde::{Deserialize, Serialize};

use super::common::{ActionSpec, Base58Address, Base64Bytes, Preamble, SyncReport, U64String};

/// Plan request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRequest {
    /// Shared preamble.
    pub preamble: Preamble,
    /// Operation to plan.
    pub action: ActionSpec,
    /// Fee payer, resolved by SDP's sponsorship layer.
    ///
    /// Required at plan time because the circuit commits it in public-input slot
    /// zero. It cannot be substituted later without re-proving.
    pub fee_payer: Base58Address,
}

/// Plan response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanResponse {
    /// The selected input notes, with their nullifiers.
    ///
    /// SDP must persist these before approval and pass `utxoHash` back to
    /// [`prove`](crate::wire::prove). Nullifiers are computable without a proof,
    /// which is what makes exactly-once possible.
    pub inputs: Vec<PlannedInput>,
    /// Addresses that must sign the outer transaction as note owners, excluding
    /// the fee payer. Under sponsorship this is non-empty, so the outer
    /// transaction needs two signatures: custody's and the fee payer's.
    pub owner_signers: Vec<Base58Address>,
    /// The circuit shape this operation resolved to.
    pub shape: CircuitShape,
    /// Echo of the requested fee payer. SDP asserts equality before proving, to
    /// catch a sponsorship rotation between plan and prove.
    pub fee_payer: Base58Address,
    /// Human-readable description of the operation, captured from the SDK's own
    /// approval request. Suitable for an approval UI.
    pub summary: String,
    /// Estimated total moved, for display and policy evaluation.
    pub total_amount: U64String,
    /// What the sync backing this plan could not account for.
    pub sync_report: SyncReport,
}

/// One selected input note.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedInput {
    /// Position in the circuit's input vector.
    pub index: u32,
    /// Commitment hash of the note. The durable handle SDP pins.
    pub utxo_hash: Base64Bytes,
    /// Nullifier this note will publish when spent.
    ///
    /// Deterministic in `(nullifier_key, utxo_hash, blinding)`, so it is stable
    /// across retries of the same input set. SDP checks these against the
    /// indexer before re-proving: any already on chain means a previous attempt
    /// landed and this operation must reconcile, not retry.
    pub nullifier: Base64Bytes,
    /// Note value in base units.
    pub amount: U64String,
}

/// Input and output counts for the selected circuit.
///
/// Only a fixed set of shapes has a verifying key. An unsupported shape is not
/// an internal error — it usually means the wallet's notes need merging first,
/// and the error surfaced to the user should say so.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitShape {
    /// Number of input notes.
    pub n_in: u8,
    /// Number of output notes.
    pub n_out: u8,
}
