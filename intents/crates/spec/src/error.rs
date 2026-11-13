use core::fmt;

/// Why a document does not parse. `parse` stops at the first error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpecError {
    /// The bytes end before a structure that the document names.
    Truncated,
    BadMagic,
    /// The document's spec version is a major version or a later minor version than this crate
    /// reads.
    UnsupportedVersion,
    WrongKind,
    /// The header's lengths do not add up to the length of the document.
    LengthMismatch,
    /// A table, pool range, or list range reaches past its region.
    OutOfBounds,
    /// A code byte has no meaning, such as an unknown account source.
    BadCode,
    /// An index names an entry that does not exist, or that must come earlier.
    BadIndex,
    /// The entries do not fit the recipe kind, such as a program recipe with two instructions.
    BadRecipe,
}

impl fmt::Display for SpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::Truncated => "the document ends early",
            Self::BadMagic => "the document does not start with SDPI",
            Self::UnsupportedVersion => "the document's spec version is not supported",
            Self::WrongKind => "the document is a different kind",
            Self::LengthMismatch => "the header lengths do not match the document",
            Self::OutOfBounds => "a range reaches past its region",
            Self::BadCode => "a code byte has no meaning",
            Self::BadIndex => "an index names an entry that does not exist",
            Self::BadRecipe => "the entries do not fit the recipe kind",
        };

        f.write_str(text)
    }
}

impl core::error::Error for SpecError {}
