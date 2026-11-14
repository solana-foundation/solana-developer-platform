use super::wire::{AccountV1, AppliesV1, ImplementationDocV1, InstructionV1, OutputBindingV1, RecipeKind, SegmentV1};
use crate::region::Region;
use crate::{
    Address, DocumentHeaderV1, DocumentIdV1, DocumentKind, LiteralV1, PoolRefV1, PostConditionV1, RangeV1, SpecError,
    TableRefV1,
};

/// An implementation document that `parse` validated, borrowed from its bytes. The view holds two
/// references. Each accessor finds its table from the fixed part, and returns entries in place.
#[derive(Clone, Copy)]
pub struct Implementation<'a> {
    bytes: &'a [u8],
    fixed: &'a ImplementationDocV1,
}

impl<'a> Implementation<'a> {
    /// Tables and the pool must lie in the body. The extension area holds only fields of later
    /// minor versions.
    pub fn parse(bytes: &'a [u8]) -> Result<Self, SpecError> {
        let implementation = Self::parse_published(bytes)?;
        implementation.validate()?;

        Ok(implementation)
    }

    /// Reads the header and the fixed part, and skips the checks of [`Self::parse`]. Only for a
    /// document that the registry published: `publish` writes a version account once, after
    /// `parse` passes, and the account never changes. An accessor still fails on an index out
    /// of bounds.
    pub fn parse_published(bytes: &'a [u8]) -> Result<Self, SpecError> {
        let header: &DocumentHeaderV1 = Region::new(bytes).fixed(0)?;
        header.check(DocumentKind::Implementation, bytes.len())?;

        let body_end =
            DocumentHeaderV1::LEN.checked_add(usize::from(header.body_len.get())).ok_or(SpecError::LengthMismatch)?;
        let body = bytes.get(..body_end).ok_or(SpecError::Truncated)?;

        Ok(Self { bytes, fixed: Region::new(body).fixed(0)? })
    }

    /// The header and the body. The view keeps the whole document, so that it stays small enough
    /// for a program's stack frame, and finds the body from the header.
    fn body(&self) -> &'a [u8] {
        let end = DocumentHeaderV1::LEN.saturating_add(usize::from(self.fixed.header.body_len.get()));

        self.bytes.get(..end).unwrap_or_default()
    }

    /// The fields of later minor versions, such as a flow's tables (spec 1.1).
    pub(super) fn extension(&self) -> &'a [u8] {
        let end = DocumentHeaderV1::LEN.saturating_add(usize::from(self.fixed.header.body_len.get()));

        self.bytes.get(end..).unwrap_or_default()
    }

    pub(super) fn spec_minor(&self) -> u8 {
        self.fixed.header.spec_minor
    }

    pub fn id(&self) -> &'a DocumentIdV1 {
        &self.fixed.id
    }

    pub fn implements(&self) -> &'a DocumentIdV1 {
        &self.fixed.implements
    }

    /// The genesis hash of the implementation's cluster.
    pub fn cluster(&self) -> &'a crate::Address {
        &self.fixed.cluster
    }

    pub fn recipe(&self) -> Result<RecipeKind, SpecError> {
        RecipeKind::try_from(self.fixed.recipe_kind)
    }

    /// Bytes of the pool, such as a name, a template, or a literal.
    pub fn text(&self, range: PoolRefV1) -> Result<&'a [u8], SpecError> {
        Region::new(self.body()).pool(self.fixed.pool)?.get(range)
    }

    pub fn name(&self) -> Result<&'a [u8], SpecError> {
        self.text(self.fixed.name)
    }

    pub fn message(&self) -> Result<&'a [u8], SpecError> {
        self.text(self.fixed.message)
    }

    /// Empty unless the recipe is remote.
    pub fn url(&self) -> Result<&'a [u8], SpecError> {
        self.text(self.fixed.url)
    }

    pub fn applies(&self) -> Result<&'a [AppliesV1], SpecError> {
        self.table(self.fixed.applies)
    }

    pub fn post_conditions(&self) -> Result<&'a [PostConditionV1], SpecError> {
        self.table(self.fixed.post_conditions)
    }

    pub fn addresses(&self) -> Result<&'a [Address], SpecError> {
        self.table(self.fixed.addresses)
    }

    pub fn accounts(&self) -> Result<&'a [AccountV1], SpecError> {
        self.table(self.fixed.accounts)
    }

    pub fn instructions(&self) -> Result<&'a [InstructionV1], SpecError> {
        self.table(self.fixed.instructions)
    }

    pub fn output_bindings(&self) -> Result<&'a [OutputBindingV1], SpecError> {
        self.table(self.fixed.output_bindings)
    }

    pub fn literals(&self) -> Result<&'a [LiteralV1], SpecError> {
        self.table(self.fixed.literals)
    }

    /// One account index for each account of the instruction, in order.
    pub fn instruction_accounts(&self, instruction: &InstructionV1) -> Result<&'a [u8], SpecError> {
        self.range(self.fixed.instruction_accounts, instruction.accounts)
    }

    /// The segments of the instruction data, in order.
    pub fn instruction_segments(&self, instruction: &InstructionV1) -> Result<&'a [SegmentV1], SpecError> {
        self.range(self.fixed.segments, instruction.segments)
    }

    /// The seeds of a PDA, from the range in its `AddressSource::Pda`.
    pub fn seeds(&self, seeds: RangeV1) -> Result<&'a [SegmentV1], SpecError> {
        self.range(self.fixed.seeds, seeds)
    }

    pub(super) fn table<T: bytemuck::Pod>(&self, table: TableRefV1) -> Result<&'a [T], SpecError> {
        Region::new(self.body()).table(table)
    }

    fn range<T: bytemuck::Pod>(&self, table: TableRefV1, range: RangeV1) -> Result<&'a [T], SpecError> {
        let entries: &'a [T] = self.table(table)?;

        entries.get(range.within(entries.len())?).ok_or(SpecError::OutOfBounds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Fixture;
    use crate::{AddressSource, Encoding, Segment, ValueRef, ValueSource};

    #[test]
    fn reads_a_static_system_transfer() {
        let bytes = Fixture::system_transfer().build();
        let implementation = Implementation::parse(&bytes).unwrap();

        assert_eq!(implementation.recipe(), Ok(RecipeKind::Static));
        assert_eq!(implementation.name().unwrap(), b"system-transfer");

        let from = implementation.accounts().unwrap().first().unwrap();
        assert!(from.writable() && from.signer());
        assert_eq!(from.address(), Ok(AddressSource::Value(ValueRef { source: ValueSource::Input, index: 0 })));

        let instruction = implementation.instructions().unwrap().first().unwrap();
        let segments = implementation.instruction_segments(instruction).unwrap();
        let Ok(Segment::Literal(discriminator)) = segments.first().unwrap().decode() else {
            panic!("the first segment is the discriminator literal");
        };

        assert_eq!(instruction.program, 2);
        assert_eq!(implementation.instruction_accounts(instruction).unwrap(), &[0, 1]);
        assert_eq!(implementation.text(discriminator).unwrap(), &[2, 0, 0, 0]);
        assert_eq!(
            segments.get(1).unwrap().decode(),
            Ok(Segment::Reference {
                value: ValueRef { source: ValueSource::Input, index: 3 },
                encoding: Encoding::U64Le
            })
        );
    }

    #[test]
    fn refuses_a_document_cut_short() {
        let bytes = Fixture::system_transfer().build();

        assert!(Implementation::parse(bytes.get(..bytes.len().saturating_sub(1)).unwrap()).is_err());
    }

    #[test]
    fn the_view_is_two_references() {
        assert_eq!(core::mem::size_of::<Implementation>(), 3 * core::mem::size_of::<usize>());
    }
}
