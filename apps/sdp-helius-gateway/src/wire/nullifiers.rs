//! `POST /v1/nullifiers/status` — has a nullifier already landed on chain?
//!
//! The endpoint that keeps reconciliation behind this boundary. SDP already stores
//! the nullifiers it pinned, so this asks only whether the indexer has seen them.
//! Pure read, no key material, always safe to repeat.
//!
//! It exists because SDP has no Photon client by design, and this gateway is the only
//! component that speaks to a Helius node.
//!
//! # The asymmetry that governs this whole endpoint
//!
//! **An indexer error must never be reported as `seen: false`.**
//!
//! A false negative tells SDP the operation did not land, so it retries; the retry
//! re-syncs the wallet, selects different notes, produces disjoint nullifiers, and
//! **the recipient is paid twice.** A false positive only stalls one operation into
//! manual reconciliation. The two failure modes are not comparable, so an indexer
//! failure must surface as `INDEXER_UNAVAILABLE` and never as a negative answer.
//!
//! That asymmetry is also why [`NullifierStatus::signature`] is nullable while
//! [`NullifierStatus::seen`] is not: if the indexer knows a nullifier is spent but the
//! publishing signature cannot be resolved, `seen: true` with a null signature still
//! correctly forbids the retry. The signature is for operator reconciliation; `seen`
//! is the control.

use serde::{Deserialize, Serialize};

use super::common::{Base58Address, Base64Bytes};

/// Request to check a set of nullifiers.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NullifierStatusRequest {
    /// Correlation identifier for logs.
    pub request_id: String,
    /// The nullifiers to check, as SDP stored them.
    pub nullifiers: Vec<Base64Bytes>,
    /// Read-your-writes floor: the indexer must have reached this slot before its
    /// answer is trustworthy.
    ///
    /// It matters more here than anywhere else in the contract. Answering from an
    /// indexer that has not caught up is exactly how a false `seen: false` is
    /// produced, so a lagging indexer must return `INDEXER_LAG` rather than an
    /// answer.
    pub require_slot: Option<u64>,
}

/// Per-nullifier answer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NullifierStatus {
    /// The nullifier this answers for, echoed so SDP need not rely on ordering.
    pub nullifier: Base64Bytes,
    /// Whether the indexer has observed this nullifier spent.
    ///
    /// Never `false` as a consequence of an error — see the module documentation.
    pub seen: bool,
    /// Slot the spend was observed at. `None` when `seen` is false, and also when
    /// `seen` is true but the slot could not be resolved.
    pub slot: Option<u64>,
    /// Signature of the transaction that published the nullifier, for operator
    /// reconciliation.
    ///
    /// Nullable independently of `seen`: a resolvable spend with an unresolvable
    /// signature is still a spend, and must still forbid a retry.
    pub signature: Option<Base58Address>,
}

/// Response carrying one answer per requested nullifier.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NullifierStatusResponse {
    /// One entry per nullifier in the request.
    pub statuses: Vec<NullifierStatus>,
    /// Slot the indexer had reached when it answered, so SDP can judge staleness
    /// even when it sent no `requireSlot`.
    pub indexer_slot: u64,
}
