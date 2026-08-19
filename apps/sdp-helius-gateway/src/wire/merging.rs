//! `POST /v1/wallets/merging` — turn on merge support for a wallet.
//!
//! # Why this endpoint exists
//!
//! `UserRecord.merging_enabled` defaults to **false** — `RegisterData` has no such
//! field, so registration never sets it — and the shielded-pool program rejects
//! `merge_transact` when it is false.
//!
//! That is a live defect in the flow contract rather than a new requirement: merge is
//! documented as the recovery path for `UNSUPPORTED_SHAPE`, the case where a wallet's
//! notes are too fragmented for one transfer and need merging first. On a freshly
//! registered wallet that recovery path fails on chain.
//!
//! Flipping the flag needs `set_merging_enabled`, which requires the **owner** to
//! sign, so it is an `sdp-api` plus custody flow. It needs a gateway endpoint only
//! because SDP does not encode zolana instructions.
//!
//! # Keyless
//!
//! `owner` and a boolean are both public, so this joins `/v1/transactions/assemble`,
//! `/v1/operations/shield`, `/v1/wallets/register` and `/v1/nullifiers/status` as an
//! endpoint that never sees a secret.
//!
//! One-time prerequisite, not a change to merge itself: the merge *transaction* still
//! carries no custody signature. This does.

use serde::{Deserialize, Serialize};

use super::common::{Base58Address, Base64Bytes};

/// Request to set a wallet's merge opt-in.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergingRequest {
    /// Correlation identifier for logs.
    pub request_id: String,
    /// The wallet whose record is being updated. It must sign.
    pub owner: Base58Address,
    /// Target state. Sent explicitly rather than implied, so the same endpoint can
    /// turn merging back off without a second route.
    pub enabled: bool,
    /// A blockhash fetched from the **same** RPC endpoint SDP will submit through,
    /// for the same reason as registration.
    pub recent_blockhash: Base58Address,
    /// Fee payer, resolved by SDP's sponsorship layer.
    pub fee_payer: Base58Address,
}

/// Response carrying the unsigned opt-in transaction.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergingResponse {
    /// Unsigned wire transaction for SDP to sign and submit.
    pub transaction: Base64Bytes,
    /// Addresses that must sign, in the order the transaction expects. Contains
    /// both the fee payer and `owner` — the program checks the owner's signature.
    pub required_signers: Vec<Base58Address>,
    /// Serialized length, so SDP can reject an oversized transaction before
    /// submitting rather than after.
    pub serialized_length: u32,
}
