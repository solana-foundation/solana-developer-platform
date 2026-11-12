use core::fmt;

use pinocchio::error::ProgramError;

/// The custom error codes of the library, as a builder returns them.
const ERROR_BASE: u32 = 0x5d1b_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildError {
    /// In staged mode the last account must be scratch: writable, and owned by the builder.
    NoScratch,
    /// The result is larger than scratch, or than the 1,024 bytes of return data in hashed mode.
    TooLarge,
    /// The caller passed other accounts than the ones that `require_accounts` names.
    WrongAccounts,
    /// In hashed mode, the caller did not pass an account that `require_accounts` names.
    MissingAccounts,
    /// The builder added an instruction after it asked for accounts.
    AfterRequest,
    /// The builder refused in hashed mode. In staged mode a refusal is a result, not an error.
    Refused,
    /// Scratch is borrowed elsewhere.
    ScratchBorrowed,
}

impl BuildError {
    fn offset(self) -> u32 {
        match self {
            Self::NoScratch => 0,
            Self::TooLarge => 1,
            Self::WrongAccounts => 2,
            Self::MissingAccounts => 3,
            Self::AfterRequest => 4,
            Self::Refused => 5,
            Self::ScratchBorrowed => 6,
        }
    }
}

impl From<BuildError> for ProgramError {
    fn from(error: BuildError) -> Self {
        ProgramError::Custom(ERROR_BASE.saturating_add(error.offset()))
    }
}

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::NoScratch => "the last account is not a writable scratch account of the builder",
            Self::TooLarge => "the result does not fit scratch or return data",
            Self::WrongAccounts => "the caller passed other accounts than the builder asked for",
            Self::MissingAccounts => "the caller did not pass an account that the builder needs",
            Self::AfterRequest => "the builder added an instruction after it asked for accounts",
            Self::Refused => "the builder refused",
            Self::ScratchBorrowed => "scratch is borrowed",
        };

        f.write_str(text)
    }
}
