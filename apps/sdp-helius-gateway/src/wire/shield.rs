//! `POST /v1/operations/shield` — deposit public funds into the pool, in one call.
//!
//! Tag 11 `DEPOSIT`, and the only flow that is a single round trip. The
//! plan/prove/assemble split exists to keep a prover call the gateway caps at 600s
//! away from a blockhash that lives about a minute, and to let SDP persist an input
//! set before approving it. A deposit has neither problem: it spends no notes, so
//! nothing is selected and nothing is proved.
//!
//! # Why this endpoint carries no key material
//!
//! A deposit needs the recipient's `ShieldedAddress`, which is a **public** value
//! the gateway reads from the on-chain user registry. The view tag it commits is
//! `viewing_pubkey.x()` — a plain function of the viewing *public* key, not the
//! counter-derived tag that transact outputs use — so no wallet projection is
//! needed either. Upstream builds the whole deposit from public address material,
//! so that a third-party depositor needs no shared secret.
//!
//! That makes shield the second endpoint after [`assemble`](crate::wire::assemble)
//! that holds no secrets, and it is the one users will hit most.
//!
//! # Retrying means re-submitting, not re-requesting
//!
//! The note's blinding factor is drawn fresh on every build and travels in the
//! clear inside the instruction. So two calls with identical arguments describe two
//! different notes and produce two independently valid transactions — and both can
//! land, debiting the depositor twice. SDP must persist the returned transaction
//! and re-submit those same bytes; a lost response is resolved by looking for
//! [`ShieldResponse::utxo_hash`] on chain, never by calling this endpoint again.

use serde::{Deserialize, Serialize};

use super::common::{Base58Address, Base64Bytes, U64String};

/// Shield request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShieldRequest {
    /// Correlation identifier. There is no preamble here because a deposit needs
    /// no secrets — see the module documentation.
    pub request_id: String,
    /// The custody wallet whose public balance is debited.
    ///
    /// It signs the transaction, and its shielded address is resolved from the
    /// on-chain user registry, so registration must already have landed —
    /// otherwise this fails with `WALLET_NOT_REGISTERED` rather than depositing
    /// into a note nobody can spend.
    pub owner: Base58Address,
    /// Mint to deposit, or the SOL sentinel.
    pub asset: Base58Address,
    /// Amount in base units.
    pub amount: U64String,
    /// Source token account for non-SOL assets.
    pub spl_token_account: Option<Base58Address>,
    /// SPL Token or Token-2022 program for non-SOL assets.
    pub spl_token_program: Option<Base58Address>,
    /// A blockhash fetched from the **same** RPC endpoint SDP will submit
    /// through, on the same rule as
    /// [`AssembleRequest::recent_blockhash`](super::assemble::AssembleRequest::recent_blockhash).
    pub recent_blockhash: Base58Address,
    /// Fee payer, resolved by SDP's sponsorship layer. Under sponsorship it
    /// differs from `owner`, and then the transaction needs both signatures.
    pub fee_payer: Base58Address,
    /// Compute-unit price in micro-lamports.
    ///
    /// There is no `cuLimit` counterpart: the reason
    /// [`ProveRequest::cu_limit`](crate::wire::prove::ProveRequest::cu_limit)
    /// exists is that verifying a Groth16 proof does not fit the default
    /// per-instruction budget, and a deposit verifies no proof.
    pub cu_price_micro_lamports: Option<u64>,
}

/// Shield response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShieldResponse {
    /// Unsigned wire transaction.
    pub transaction: Base64Bytes,
    /// Addresses that must sign, in the order the transaction expects. The fee
    /// payer occupies index zero; `owner` follows, because the deposit debits its
    /// public balance.
    pub required_signers: Vec<Base58Address>,
    /// Commitment hash of the note this deposit creates.
    ///
    /// The only handle to a shield attempt that exists before it lands, so it is
    /// what reconciliation searches for after a lost response. A deposit publishes
    /// no nullifier, so there is nothing else to look for.
    pub utxo_hash: Base64Bytes,
    /// Serialized length in bytes, on the same rationale as
    /// [`AssembleResponse::serialized_length`](super::assemble::AssembleResponse::serialized_length).
    pub serialized_length: u32,
}
