use pinocchio::error::ProgramError;
use sdp_intents_builder::BuildError;

use crate::token_data::InvalidTokenData;

/// A precondition of the transfer that does not hold. Each one is a transfer that Token-2022
/// refuses, or one that SDP does not support.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    NotToken2022Mint,
    InvalidTokenData,
    NonTransferable,
    MintPaused,
    InterestBearing,
    ScaledUiAmount,
    UnsupportedExtension,
    NoSourceAccount,
    SourceFrozen,
    InsufficientFunds,
    DestinationFrozen,
    MemoRequired,
    ConfidentialOnly,
    HookUnresolvable,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotToken2022Mint => "notToken2022Mint",
            Self::InvalidTokenData => "invalidTokenData",
            Self::NonTransferable => "nonTransferable",
            Self::MintPaused => "mintPaused",
            Self::InterestBearing => "interestBearing",
            Self::ScaledUiAmount => "scaledUiAmount",
            Self::UnsupportedExtension => "unsupportedExtension",
            Self::NoSourceAccount => "noSourceAccount",
            Self::SourceFrozen => "sourceFrozen",
            Self::InsufficientFunds => "insufficientFunds",
            Self::DestinationFrozen => "destinationFrozen",
            Self::MemoRequired => "memoRequired",
            Self::ConfidentialOnly => "confidentialOnly",
            Self::HookUnresolvable => "hookUnresolvable",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::NotToken2022Mint => "the mint is not a Token-2022 mint",
            Self::InvalidTokenData => "a Token-2022 account has data that the builder cannot read",
            Self::NonTransferable => "the mint is non-transferable",
            Self::MintPaused => "the mint is paused",
            Self::InterestBearing => "the mint is interest-bearing, and SDP does not transfer it",
            Self::ScaledUiAmount => "the mint has a scaled UI amount, and SDP does not transfer it",
            Self::UnsupportedExtension => "the mint has an extension that the builder does not know",
            Self::NoSourceAccount => "the sender has no token account for the mint",
            Self::SourceFrozen => "the sender's token account is frozen",
            Self::InsufficientFunds => "the sender holds less than the amount",
            Self::DestinationFrozen => "the recipient's token account is frozen, or the mint freezes new accounts",
            Self::MemoRequired => "the recipient's token account requires a memo",
            Self::ConfidentialOnly => "the recipient's token account accepts only confidential transfers",
            Self::HookUnresolvable => "the builder cannot resolve the accounts of the mint's transfer hook",
        }
    }
}

/// Why a build stops before it returns instructions.
#[derive(Debug, PartialEq, Eq)]
pub enum Stop {
    Refused(Refusal),
    Failed(ProgramError),
}

impl From<Refusal> for Stop {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

impl From<InvalidTokenData> for Refusal {
    fn from(_: InvalidTokenData) -> Self {
        Self::InvalidTokenData
    }
}

impl From<InvalidTokenData> for Stop {
    fn from(_: InvalidTokenData) -> Self {
        Self::Refused(Refusal::InvalidTokenData)
    }
}

impl From<ProgramError> for Stop {
    fn from(error: ProgramError) -> Self {
        Self::Failed(error)
    }
}

impl From<BuildError> for Stop {
    fn from(error: BuildError) -> Self {
        Self::Failed(error.into())
    }
}
