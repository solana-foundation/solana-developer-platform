use super::wire::{IntentDocV1, IntentOptions};
use crate::region::Region;
use crate::{DocumentHeaderV1, DocumentIdV1, DocumentKind, PoolRefV1, SpecError};

/// An intent document that `parse` validated, borrowed from its bytes. `parse` checks only the
/// layout. The input values are checked against the interface by the code that binds the two.
#[derive(Clone, Copy)]
pub struct Intent<'a> {
    body: &'a [u8],
    fixed: &'a IntentDocV1,
}

impl<'a> Intent<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, SpecError> {
        let header: &DocumentHeaderV1 = Region::new(bytes).fixed(0)?;
        header.check(DocumentKind::Intent, bytes.len())?;

        let body_end =
            DocumentHeaderV1::LEN.checked_add(usize::from(header.body_len.get())).ok_or(SpecError::LengthMismatch)?;
        let body = bytes.get(..body_end).ok_or(SpecError::Truncated)?;

        let intent = Self { body, fixed: Region::new(body).fixed(0)? };
        IntentOptions::from_flags(intent.fixed.flags)?;
        intent.inputs()?.iter().try_for_each(|input| intent.text(*input).map(|_| ()))?;

        Ok(intent)
    }

    pub fn interface(&self) -> &'a DocumentIdV1 {
        &self.fixed.interface
    }

    pub fn implementation(&self) -> &'a DocumentIdV1 {
        &self.fixed.implementation
    }

    pub fn options(&self) -> Result<IntentOptions, SpecError> {
        IntentOptions::from_flags(self.fixed.flags)
    }

    pub fn inputs(&self) -> Result<&'a [PoolRefV1], SpecError> {
        Region::new(self.body).table(self.fixed.inputs)
    }

    /// The borsh bytes of input `index`.
    pub fn input(&self, index: u8) -> Result<&'a [u8], SpecError> {
        let range = self.inputs()?.get(usize::from(index)).ok_or(SpecError::BadIndex)?;

        self.text(*range)
    }

    fn text(&self, range: PoolRefV1) -> Result<&'a [u8], SpecError> {
        Region::new(self.body).pool(self.fixed.pool)?.get(range)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::IntentFixture;

    #[test]
    fn reads_each_input_in_place() {
        let bytes = IntentFixture::token_transfer().build();
        let intent = Intent::parse(&bytes).unwrap();

        assert_eq!(intent.inputs().unwrap().len(), 5);
        assert_eq!(intent.input(3).unwrap(), 100_000_000u64.to_le_bytes());
        assert_eq!(intent.input(4).unwrap(), [0]);
        assert_eq!(intent.options(), Ok(IntentOptions::default()));
    }

    #[test]
    fn refuses_an_input_outside_the_pool() {
        let mut fixture = IntentFixture::token_transfer();
        fixture.inputs.last_mut().unwrap().len = 50.into();

        assert_eq!(Intent::parse(&fixture.build()).err(), Some(SpecError::OutOfBounds));
    }

    #[test]
    fn refuses_an_unknown_option() {
        let mut fixture = IntentFixture::token_transfer();
        fixture.flags = 0x10;

        assert_eq!(Intent::parse(&fixture.build()).err(), Some(SpecError::BadCode));
    }

    #[test]
    fn the_view_is_two_references() {
        assert_eq!(core::mem::size_of::<Intent>(), 3 * core::mem::size_of::<usize>());
    }
}
