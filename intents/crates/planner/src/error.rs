use core::fmt;

use sdp_intents_engine::EngineError;
use sdp_intents_spec::SpecError;

/// A runtime limit that a transaction can break.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limit {
    Accounts,
    Instructions,
    Bytes,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlanError {
    Engine(EngineError),
    Spec(SpecError),
    /// The builder refused the intent, with its code and message.
    Refused {
        code: String,
        message: String,
    },
    /// The simulation failed, with the runtime error and the program logs.
    Simulation {
        error: String,
        logs: Vec<String>,
    },
    /// The builder set no return data, or another program set it.
    NoBuilderResult,
    /// The result holds no scratch account, so the staged result cannot be read.
    NoScratch,
    /// The builder asked for accounts in more than 4 rounds.
    TooManyRounds,
    /// A remote recipe that returns a whole transaction, which prepare cannot plan yet.
    RemoteRecipe,
    /// The endpoint names this output with another address than the record binds, or leaves out
    /// an output that the record does not bind.
    RemoteOutput(u8),
    /// A remote recipe with `verify_intent` needs the assertions, because `verify_intent` cannot
    /// rebuild its instructions.
    RemoteNeedsAssertions,
    /// The provider's transaction breaks a rule of `DESIGN.md`, 4.16, which the text names.
    RemoteTransaction(&'static str),
    /// A provider signed for an account that the record does not list and the transaction does not
    /// create.
    ProviderSigner(sdp_intents_spec::Address),
    /// A builder names the rent payer's address itself, such as an owner who pays the rent.
    /// `verify_intent` cannot tell that account from the rent placeholder yet.
    RentPayerInRecipe,
    /// `next` ran while a simulation has no answer, or `simulated` ran with no simulation asked.
    OutOfOrder,
    /// The intent asks for a check that prepare cannot build yet, by its option name.
    Unavailable(&'static str),
    /// A postcondition or a payer rule does not hold in the simulation of the final transaction.
    CheckFailed(String),
    /// A signer is no payer, no signer input, and no account that a builder signs for.
    UnknownSigner(sdp_intents_spec::Address),
    /// The result of the final simulation does not hold one account for each that it observes.
    NoAccounts,
    /// The final simulation reports no compute units, so the plan cannot set its budget.
    NoUnits,
    /// A template does not parse. The compiler writes only templates that parse.
    BadTemplate,
    /// Text in the message is not printable ASCII, so a character could look like another.
    UnsafeText,
    /// A value names an account that is not resolved, or whose data is not fetched.
    Unresolved,
    /// The account that an `amount` display names is not a mint.
    NotAMint(sdp_intents_spec::Address),
    /// The plan holds no intent.
    NoIntents,
    /// The recipe built no instructions, so no instruction can follow `verify_intent`.
    NoInstructions,
    /// The transaction breaks a runtime limit.
    DoesNotFit {
        limit: Limit,
        used: usize,
        max: usize,
    },
    /// No bump puts a registry address off the curve.
    NoRegistryAddress,
    /// No bump puts the Lighthouse memory address off the curve.
    NoMemoryAddress,
    /// The postconditions cannot be asserted with Lighthouse.
    Guard(sdp_intents_lighthouse::GuardError),
}

impl Limit {
    pub fn as_text(self) -> &'static str {
        match self {
            Self::Accounts => "accounts",
            Self::Instructions => "instructions",
            Self::Bytes => "bytes",
        }
    }
}

impl From<EngineError> for PlanError {
    fn from(error: EngineError) -> Self {
        Self::Engine(error)
    }
}

impl From<SpecError> for PlanError {
    fn from(error: SpecError) -> Self {
        Self::Spec(error)
    }
}

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Engine(error) => write!(f, "{error}"),
            Self::Spec(error) => write!(f, "the builder result does not parse: {error}"),
            Self::Refused { code, message } => write!(f, "the builder refused: {code}: {message}"),
            Self::Simulation { error, .. } => write!(f, "the simulation failed: {error}"),
            Self::NoBuilderResult => f.write_str("the builder returned no result"),
            Self::NoScratch => f.write_str("the simulation returned no scratch account"),
            Self::TooManyRounds => f.write_str("the builder asked for accounts in more than 4 rounds"),
            Self::RemoteRecipe => f.write_str("remote recipes that return a transaction are not supported yet"),
            Self::RemoteOutput(output) => write!(f, "the endpoint's output {output} differs from the record, or is missing"),
            Self::RemoteTransaction(rule) => write!(f, "the provider's transaction is refused: {rule}"),
            Self::ProviderSigner(address) => write!(
                f,
                "the provider signed for {}, which the record does not list and the transaction does not create",
                crate::render::base58(address)
            ),
            Self::RemoteNeedsAssertions => f.write_str(
                "a remote recipe needs `assertions`, because verify_intent cannot rebuild its instructions. Turn both checks off to trust the endpoint.",
            ),
            Self::RentPayerInRecipe => f.write_str(
                "the builder names the rent payer as one of its own accounts, which verify_intent cannot check yet. Pay the rent from another wallet.",
            ),
            Self::OutOfOrder => f.write_str("the planner steps ran out of order"),
            Self::Unavailable(option) => write!(
                f,
                "the intent sets `options.{option}`, and prepare cannot build that check yet. Set it to false to plan without it."
            ),
            Self::CheckFailed(check) => write!(f, "the simulation breaks a guarantee: {check}"),
            Self::UnknownSigner(address) => write!(f, "{} signs, and no role names it", bs58::encode(address.0).into_string()),
            Self::NoAccounts => f.write_str("the simulation returned another number of accounts than it observes"),
            Self::NoUnits => f.write_str("the simulation reports no compute units"),
            Self::BadTemplate => f.write_str("a template does not parse"),
            Self::UnsafeText => f.write_str("the message holds text that is not printable ASCII"),
            Self::Unresolved => f.write_str("a value names an account that is not loaded"),
            Self::NotAMint(address) => write!(f, "{} is not a mint", bs58::encode(address.0).into_string()),
            Self::NoIntents => f.write_str("the plan holds no intent"),
            Self::NoInstructions => f.write_str("the recipe built no instructions"),
            Self::DoesNotFit { limit, used, max } => write!(
                f,
                "the transaction needs {used} {}, and the limit is {max}. Turn off `assertions` or `verifyIntent` in an intent, or plan fewer intents.",
                limit.as_text()
            ),
            Self::NoRegistryAddress => f.write_str("no bump puts a registry address off the curve"),
            Self::NoMemoryAddress => f.write_str("no bump puts the Lighthouse memory address off the curve"),
            Self::Guard(error) => write!(f, "the assertions cannot guard the intent: {error}"),
        }
    }
}

impl std::error::Error for PlanError {}
