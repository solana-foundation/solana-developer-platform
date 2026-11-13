//! The intent document as it is stored. `verify_intent` takes these bytes as its instruction data.

use bytemuck::{Pod, Zeroable};

use crate::{DocumentHeaderV1, DocumentIdV1, PoolRefV1, SpecError, TableRefV1};

const ALLOW_UNAPPROVED: u8 = 1;
const NO_ASSERTIONS: u8 = 2;
const NO_VERIFY_INTENT: u8 = 4;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct IntentDocV1 {
    pub header: DocumentHeaderV1,
    /// Exact versions. The service pins the ranges of the JSON intent at `prepare`.
    pub interface: DocumentIdV1,
    pub implementation: DocumentIdV1,
    pub flags: u8,
    /// One `PoolRefV1` for each input of the interface, in interface order. Each range holds the
    /// input in borsh, so an optional input starts with its tag.
    pub inputs: TableRefV1,
    pub pool: PoolRefV1,
}

/// The intent options. The checks default to on, so the flags store the opt-outs and a zero byte is
/// the default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IntentOptions {
    pub allow_unapproved: bool,
    pub assertions: bool,
    pub verify_intent: bool,
}

impl Default for IntentOptions {
    fn default() -> Self {
        Self { allow_unapproved: false, assertions: true, verify_intent: true }
    }
}

impl IntentOptions {
    pub fn to_flags(self) -> u8 {
        let flag = |set: bool, bit: u8| if set { bit } else { 0 };

        flag(self.allow_unapproved, ALLOW_UNAPPROVED)
            | flag(!self.assertions, NO_ASSERTIONS)
            | flag(!self.verify_intent, NO_VERIFY_INTENT)
    }

    pub fn from_flags(flags: u8) -> Result<Self, SpecError> {
        if flags & !(ALLOW_UNAPPROVED | NO_ASSERTIONS | NO_VERIFY_INTENT) != 0 {
            return Err(SpecError::BadCode);
        }

        Ok(Self {
            allow_unapproved: flags & ALLOW_UNAPPROVED != 0,
            assertions: flags & NO_ASSERTIONS == 0,
            verify_intent: flags & NO_VERIFY_INTENT == 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_pinned() {
        assert_eq!(core::mem::size_of::<IntentDocV1>(), 159);
    }

    #[test]
    fn the_default_options_are_a_zero_byte() {
        assert_eq!(IntentOptions::default().to_flags(), 0);
        assert_eq!(IntentOptions::from_flags(0), Ok(IntentOptions::default()));

        let options = IntentOptions { allow_unapproved: true, assertions: false, verify_intent: false };
        assert_eq!(IntentOptions::from_flags(options.to_flags()), Ok(options));
        assert_eq!(IntentOptions::from_flags(8), Err(SpecError::BadCode));
    }
}
