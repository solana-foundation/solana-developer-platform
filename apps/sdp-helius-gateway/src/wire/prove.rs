//! `POST /v1/operations/prove` — assemble the witness and obtain a proof.
//!
//! The long call, and nothing upstream bounds it. The SDK's 600-second constant is
//! a timeout on one HTTP request, and a queued proof's poll ceiling counts only the
//! time spent sleeping between polls, so the gateway imposes the only wall-clock
//! bound there is. See `PROVE_TIMEOUT` in `crate::routes`.
//!
//! Minutes either way, so SDP must drive this from a background reconciler rather
//! than a user-facing request. It must not run inside the approval replay path,
//! which is bounded by Cloud Run's request timeout.
//!
//! Retrying is safe **only** when `pinnedInputs` is supplied and unchanged: the
//! proof is a pure function of the witness, so the same input set yields the same
//! nullifiers and the on-chain nullifier queue admits at most one submission.

use serde::{Deserialize, Serialize};

use super::common::{ActionSpec, Base58Address, Base64Bytes, Preamble};

/// Prove request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProveRequest {
    /// Shared preamble.
    pub preamble: Preamble,
    /// Operation to prove. Must match the action that was planned.
    pub action: ActionSpec,
    /// Fee payer. Committed by the circuit, so it must equal the value planned.
    pub fee_payer: Base58Address,
    /// Commitment hashes from [`PlanResponse::inputs`], in order.
    ///
    /// Supplying these is what makes a retry safe. Omitting them lets the
    /// gateway re-select from a freshly synced wallet, which can pick different
    /// notes and produce a second independently-valid transaction — double-paying
    /// the recipient if the first one landed.
    ///
    /// [`PlanResponse::inputs`]: crate::wire::plan::PlanResponse::inputs
    pub pinned_inputs: Vec<Base64Bytes>,
    /// Compute-unit limit override.
    ///
    /// Exposed per request because the SDK configures it on the client, which
    /// would otherwise bake one value into the gateway and leave SDP unable to
    /// tune it. A shielded transact verifies a Groth16 proof on chain and does
    /// not fit the default per-instruction budget.
    pub cu_limit: Option<u32>,
    /// Compute-unit price in micro-lamports. Not committed by the proof, so it
    /// may also be adjusted at assembly time.
    pub cu_price_micro_lamports: Option<u64>,
}

/// Prove response.
///
/// Everything needed to assemble a transaction later, and nothing secret — so
/// SDP can persist it and survive a restart between proving and signing.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProveResponse {
    /// Borsh-serialized shielded-pool instruction data, proof included.
    pub transact_ix_data: Base64Bytes,
    /// Tree account the inputs are spent from.
    pub input_tree: Base58Address,
    /// Tree account the outputs are appended to.
    pub output_tree: Base58Address,
    /// Note owners that must sign the outer transaction, excluding the fee payer.
    pub owner_signers: Vec<Base58Address>,
    /// Nullifiers this proof publishes. SDP stores them to detect a landed
    /// attempt during reconciliation.
    pub nullifiers: Vec<Base64Bytes>,
    /// Wall-clock proving time, for capacity planning and alerting.
    pub proof_duration_ms: u64,
}
