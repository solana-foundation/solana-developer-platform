//! `POST /v1/wallets/sync` — scan the indexer and report private state.

use serde::{Deserialize, Serialize};

use super::common::{
    Base58Address, Base64Bytes, Preamble, SyncReport, U64String, WalletProjection,
};

/// Sync request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncRequest {
    /// Shared preamble. Supply `walletProjection` to resume rather than
    /// full-rescan, and `requireSlot` after a submission to get read-your-writes.
    pub preamble: Preamble,
}

/// Sync response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    /// Private balance per asset.
    pub balances: Vec<AssetBalance>,
    /// Decrypted private transaction history, newest first.
    pub transactions: Vec<PrivateTransaction>,
    /// Updated projection for SDP to persist encrypted and pass back next time.
    pub projection: WalletProjection,
    /// What this sync could not account for. Non-zero counters mean `balances`
    /// may be incomplete.
    pub sync_report: SyncReport,
    /// Slot the indexer had reached when it assembled this answer. SDP should
    /// store it as the wallet's cursor.
    pub slot: u64,
}

/// Private balance for one asset.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetBalance {
    /// Mint address, or the SOL sentinel mint.
    pub asset: Base58Address,
    /// Spendable total in base units.
    pub amount: U64String,
    /// Number of unspent notes backing it.
    ///
    /// Worth surfacing in the UI: the transact circuit supports a bounded set of
    /// input/output shapes, so a balance spread across many small notes can be
    /// unspendable in one transfer until merged.
    pub note_count: u32,
}

/// One decrypted private transaction.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateTransaction {
    /// On-chain signature.
    pub signature: Base58Address,
    /// Slot it was indexed at.
    pub slot: u64,
    /// Asset moved.
    pub asset: Base58Address,
    /// Amount in base units.
    pub amount: U64String,
    /// Direction relative to this wallet.
    pub direction: Direction,
    /// Commitment hashes of the notes this transaction created for the wallet.
    pub output_utxo_hashes: Vec<Base64Bytes>,
}

/// Which way value moved.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    /// Value entered the wallet.
    Inbound,
    /// Value left the wallet.
    Outbound,
}
