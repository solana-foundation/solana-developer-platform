//! How a build ends, and the preconditions that the builder refuses with a code.

use sdp_intents_builder::{Build, BuildError};

pub(crate) enum Outcome {
    /// The instructions and the outputs are in the build.
    Built,
    /// The build asked for accounts with `require_accounts`.
    NeedsAccounts,
    Refused(Refusal),
}

impl Outcome {
    pub(crate) fn finish(self, build: Build<'_>) -> Result<(), BuildError> {
        match self {
            Self::Refused(refusal) => build.refuse(refusal.code(), refusal.message()),
            Self::Built | Self::NeedsAccounts => build.finish(),
        }
    }
}

/// A precondition that the builder reads from the accounts and that does not hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    AssetMismatch,
    ZeroAmount,
    BelowMinimumDeposit,
    DepositCapReached,
    InsufficientBalance,
    SharesBelowMinimum,
    ZeroShares,
    InsufficientShares,
    NoReserves,
    InsufficientLiquidity,
    AmountBelowMinimum,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::AssetMismatch => "assetMismatch",
            Self::ZeroAmount => "zeroAmount",
            Self::BelowMinimumDeposit => "belowMinimumDeposit",
            Self::DepositCapReached => "depositCapReached",
            Self::InsufficientBalance => "insufficientBalance",
            Self::SharesBelowMinimum => "sharesBelowMinimum",
            Self::ZeroShares => "zeroShares",
            Self::InsufficientShares => "insufficientShares",
            Self::NoReserves => "noReserves",
            Self::InsufficientLiquidity => "insufficientLiquidity",
            Self::AmountBelowMinimum => "amountBelowMinimum",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::AssetMismatch => "the asset is not the token mint of the vault",
            Self::ZeroAmount => "the amount is zero",
            Self::BelowMinimumDeposit => "the amount is below the minimum deposit of the vault",
            Self::DepositCapReached => "the deposit takes the vault above its deposit cap",
            Self::InsufficientBalance => "the owner holds less of the asset than the amount",
            Self::SharesBelowMinimum => "the vault mints fewer shares than the minimum for this amount",
            Self::ZeroShares => "the share amount is zero",
            Self::InsufficientShares => "the owner holds fewer shares than the share amount",
            Self::NoReserves => "the vault allocates to no reserve",
            Self::InsufficientLiquidity => "the vault and its reserves hold less liquidity than the withdrawal needs",
            Self::AmountBelowMinimum => "the shares are worth less than the minimum amount",
        }
    }
}
