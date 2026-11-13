use std::fmt;

use sdp_intents_spec::{Address, SpecError};

/// Why a document does not decompile. The decompiler stops at the first error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecompileError {
    /// The bytes do not parse as the document, or an index or a code byte is not valid.
    Spec(SpecError),
    /// The organizations hold no name for this publisher.
    UnknownPublisher(Address),
    /// The interface is not the one that the implementation implements.
    WrongInterface,
    /// A name, a template, or a URL is not UTF-8.
    NotUtf8,
    /// The name of a document does not hash to the name hash of its id.
    NameMismatch,
    /// A compiled template holds a placeholder that templates do not have.
    BadTemplate,
    /// The bytes hold something that the JSON form cannot state.
    Unrepresentable(&'static str),
}

impl From<SpecError> for DecompileError {
    fn from(error: SpecError) -> Self {
        Self::Spec(error)
    }
}

impl fmt::Display for DecompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spec(error) => write!(f, "the document does not parse: {error}"),
            Self::UnknownPublisher(address) => {
                write!(f, "no organization is known for the publisher {}", bs58::encode(address.0).into_string())
            }
            Self::WrongInterface => f.write_str("the interface is not the one that the implementation implements"),
            Self::NotUtf8 => f.write_str("a name, a template, or a URL is not UTF-8"),
            Self::NameMismatch => f.write_str("the name of the document does not match the name hash of its id"),
            Self::BadTemplate => f.write_str("a template holds a placeholder that templates do not have"),
            Self::Unrepresentable(what) => write!(f, "the JSON form cannot state {what}"),
        }
    }
}

impl std::error::Error for DecompileError {}
