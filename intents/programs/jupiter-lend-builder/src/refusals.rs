//! The refusals of the builder: the preconditions that it reads before it builds.

/// A precondition that does not hold, as the builder returns it in `Refused`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: &'static str,
}

pub const ZERO_AMOUNT: Refusal = Refusal { code: "zeroAmount", message: "the amount is zero" };
pub const ZERO_SHARES: Refusal = Refusal { code: "zeroShares", message: "the share amount is zero" };
pub const NOT_A_VAULT: Refusal =
    Refusal { code: "notAVault", message: "the vault is not a Jupiter Lend earn market of the main market" };
pub const VAULT_ASSET_MISMATCH: Refusal =
    Refusal { code: "vaultAssetMismatch", message: "the vault lends another asset" };
pub const UNSUPPORTED_TOKEN_PROGRAM: Refusal =
    Refusal { code: "unsupportedTokenProgram", message: "the asset is not an SPL Token mint" };
pub const VAULT_ACCOUNTS_MISMATCH: Refusal =
    Refusal { code: "vaultAccountsMismatch", message: "the vault names other market accounts than the record derives" };
pub const LIQUIDITY_UNREADABLE: Refusal = Refusal {
    code: "liquidityUnreadable",
    message: "the liquidity account or the supply position of the vault is not readable",
};
pub const PROTOCOL_LOCKED: Refusal =
    Refusal { code: "protocolLocked", message: "the Jupiter Lend liquidity protocol is locked" };
pub const VAULT_PAUSED: Refusal = Refusal { code: "vaultPaused", message: "the liquidity protocol paused the vault" };
pub const INSUFFICIENT_BALANCE: Refusal =
    Refusal { code: "insufficientBalance", message: "the owner holds less of the asset than the amount" };
pub const MIN_SHARES_NOT_MET: Refusal =
    Refusal { code: "minSharesNotMet", message: "the amount buys fewer shares than minShares at the vault price" };
pub const INSUFFICIENT_SHARES: Refusal =
    Refusal { code: "insufficientShares", message: "the owner holds fewer shares than the share amount" };
pub const INSUFFICIENT_LIQUIDITY: Refusal =
    Refusal { code: "insufficientLiquidity", message: "the vault holds less of the asset than minAmount" };
