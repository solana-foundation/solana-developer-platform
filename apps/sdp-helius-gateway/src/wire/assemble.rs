//! `POST /v1/transactions/assemble` — turn a proof into an unsigned transaction.
//!
//! The only endpoint that takes **no key material**: it is a pure function of a
//! proved payload plus a fresh blockhash. That is what makes it cheap, freely
//! retryable, and the right place to absorb blockhash expiry.
//!
//! Instruction encoding, account ordering, compute-budget composition and
//! settlement-transfer validation all follow upstream's layout, so assembly stays
//! in this service rather than being reimplemented against a hand-maintained copy
//! of that layout. A copy is where account-layout drift turns into a decode defect.

use serde::{Deserialize, Serialize};

use super::common::{Base58Address, Base64Bytes};
use super::prove::ProveResponse;

/// Assemble request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssembleRequest {
    /// Correlation identifier. There is no preamble here because assembly needs
    /// no secrets.
    pub request_id: String,
    /// The payload returned by prove, replayed from SDP's storage.
    pub proved: ProveResponse,
    /// A blockhash fetched from the **same** RPC endpoint SDP will submit
    /// through. Fetching from one endpoint and submitting to another is a common
    /// cause of spurious "blockhash not found".
    pub recent_blockhash: Base58Address,
    /// Fee payer. Must equal the one committed by the proof; assembly rejects a
    /// mismatch rather than producing a transaction that fails on chain.
    pub fee_payer: Base58Address,
    /// Compute-unit price override. Safe to change here — the proof does not
    /// commit compute-budget instructions.
    pub cu_price_micro_lamports: Option<u64>,
}

/// Assemble response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembleResponse {
    /// Unsigned wire transaction.
    pub transaction: Base64Bytes,
    /// Addresses that must sign, in the order the transaction expects. The fee
    /// payer occupies index zero.
    pub required_signers: Vec<Base58Address>,
    /// Serialized length in bytes.
    ///
    /// Returned so SDP can log how close an operation runs to the 1232-byte
    /// packet limit. The gateway already rejects anything over it, but a
    /// withdrawal with several legs can approach the limit while still
    /// succeeding, and that is worth seeing before it starts failing.
    pub serialized_length: u32,
}
