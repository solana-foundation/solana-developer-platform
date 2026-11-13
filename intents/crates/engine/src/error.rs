use core::fmt;

use sdp_intents_spec::{RecipeKind, SpecError};

/// Why the engine refuses an intent. An index names an entry of the implementation or the interface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineError {
    Spec(SpecError),
    /// The intent names another interface or implementation than the ones given.
    WrongDocument,
    /// The implementation implements another interface, or a later version of this one.
    WrongInterface,
    /// The intent does not hold a value of the input's type.
    BadInput {
        input: u8,
    },
    /// An input check of `applies` does not hold.
    AppliesFailed {
        applies: u8,
    },
    /// An optional input is present, and the recipe does not read it.
    UnusedInput {
        input: u8,
    },
    /// The call needs another recipe kind, such as `builder_call` on a static recipe. A remote
    /// recipe has no instructions that the engine can build.
    WrongRecipe {
        expected: RecipeKind,
    },
    /// A builder call holds more than 64 accounts.
    TooManyAccounts,
    /// A builder asked for a payer as an account. A builder names the rent payer only with the
    /// placeholder.
    PayerAccount,
    /// The account's owner is not the program that the implementation names.
    WrongOwner {
        account: u8,
    },
    /// The account's data ends before the bytes that the implementation reads.
    ShortData {
        account: u8,
    },
    /// The caller does not hold the data of an account that the implementation reads. `resolve` returns
    /// these accounts, so this error means that the caller did not supply them.
    MissingData {
        account: u8,
    },
    /// A PDA has more than 16 seeds or a seed over 32 bytes, or no bump gives an address.
    BadSeeds {
        account: u8,
    },
    /// The caller stated another count of bumps than the implementation has program addresses.
    WrongBumps,
    /// `instructions` runs only after `resolve` returns `Complete`.
    NotResolved,
    /// The address of the account is not resolved yet.
    Unresolved {
        account: u8,
    },
    /// The output has no account that the implementation binds it to.
    UnboundOutput {
        output: u8,
    },
    /// The value has no form in the encoding, such as an optional input outside `borsh`.
    BadEncoding,
    /// A postcondition names a value of another type, an absent input, or an output that the
    /// builder did not write.
    BadCondition,
}

impl From<SpecError> for EngineError {
    fn from(error: SpecError) -> Self {
        Self::Spec(error)
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spec(error) => write!(f, "{error}"),
            Self::WrongDocument => f.write_str("the intent names other documents"),
            Self::WrongInterface => f.write_str("the implementation does not implement this interface version"),
            Self::BadInput { input } => write!(f, "input {input} does not hold a value of its type"),
            Self::AppliesFailed { applies } => write!(f, "applies check {applies} does not hold"),
            Self::UnusedInput { input } => write!(f, "input {input} is present, and the recipe does not read it"),
            Self::WrongRecipe { expected } => write!(f, "the call needs a {expected:?} recipe"),
            Self::TooManyAccounts => f.write_str("the builder call holds more than 64 accounts"),
            Self::PayerAccount => f.write_str("a builder asked for a payer as an account"),
            Self::WrongOwner { account } => write!(f, "account {account} has another owner"),
            Self::ShortData { account } => write!(f, "the data of account {account} is too short"),
            Self::MissingData { account } => write!(f, "the data of account {account} is not loaded"),
            Self::BadSeeds { account } => write!(f, "the seeds of account {account} give no address"),
            Self::WrongBumps => f.write_str("the bumps are not one for each program address of the implementation"),
            Self::NotResolved => f.write_str("the recipe is not resolved"),
            Self::Unresolved { account } => write!(f, "account {account} is not resolved"),
            Self::UnboundOutput { output } => write!(f, "output {output} has no account"),
            Self::BadEncoding => f.write_str("the value has no form in this encoding"),
            Self::BadCondition => f.write_str("a postcondition names a value that it cannot read"),
        }
    }
}

impl core::error::Error for EngineError {}
