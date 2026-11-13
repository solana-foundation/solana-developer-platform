use super::wire::{InputV1, InterfaceDocV1, OutputV1};
use crate::region::Region;
use crate::{
    Address, DocumentHeaderV1, DocumentIdV1, DocumentKind, LiteralV1, PoolRefV1, PostConditionV1, SpecError, TableRefV1,
};

/// An interface document that `parse` validated, borrowed from its bytes. It holds two references,
/// and each accessor returns entries in place.
#[derive(Clone, Copy)]
pub struct Interface<'a> {
    body: &'a [u8],
    fixed: &'a InterfaceDocV1,
}

impl<'a> Interface<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, SpecError> {
        let header: &DocumentHeaderV1 = Region::new(bytes).fixed(0)?;
        header.check(DocumentKind::Interface, bytes.len())?;

        let body_end =
            DocumentHeaderV1::LEN.checked_add(usize::from(header.body_len.get())).ok_or(SpecError::LengthMismatch)?;
        let body = bytes.get(..body_end).ok_or(SpecError::Truncated)?;

        let interface = Self { body, fixed: Region::new(body).fixed(0)? };
        interface.validate()?;

        Ok(interface)
    }

    pub fn id(&self) -> &'a DocumentIdV1 {
        &self.fixed.id
    }

    pub fn text(&self, range: PoolRefV1) -> Result<&'a [u8], SpecError> {
        Region::new(self.body).pool(self.fixed.pool)?.get(range)
    }

    pub fn name(&self) -> Result<&'a [u8], SpecError> {
        self.text(self.fixed.name)
    }

    /// The template for people, such as `Send {i3} {i2} to {i1}`.
    pub fn display(&self) -> Result<&'a [u8], SpecError> {
        self.text(self.fixed.display)
    }

    /// Whether the provider settles the operation after the transaction.
    pub fn settles_later(&self) -> bool {
        self.fixed.flags & super::wire::INTERFACE_SETTLES_LATER != 0
    }

    pub fn inputs(&self) -> Result<&'a [InputV1], SpecError> {
        self.table(self.fixed.inputs)
    }

    pub fn outputs(&self) -> Result<&'a [OutputV1], SpecError> {
        self.table(self.fixed.outputs)
    }

    pub fn post_conditions(&self) -> Result<&'a [PostConditionV1], SpecError> {
        self.table(self.fixed.post_conditions)
    }

    pub fn addresses(&self) -> Result<&'a [Address], SpecError> {
        self.table(self.fixed.addresses)
    }

    pub fn literals(&self) -> Result<&'a [LiteralV1], SpecError> {
        self.table(self.fixed.literals)
    }

    fn table<T: bytemuck::Pod>(&self, table: TableRefV1) -> Result<&'a [T], SpecError> {
        Region::new(self.body).table(table)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::InterfaceFixture;
    use crate::{BaseType, ValueRef, ValueSource};

    #[test]
    fn reads_the_token_transfer_interface() {
        let bytes = InterfaceFixture::token_transfer().build();
        let interface = Interface::parse(&bytes).unwrap();

        assert_eq!(interface.name().unwrap(), b"token.transfer");
        assert_eq!(interface.inputs().unwrap().len(), 5);

        let amount = interface.inputs().unwrap().get(3).unwrap();
        assert_eq!(interface.text(amount.name).unwrap(), b"amount");
        assert_eq!(amount.value_type().unwrap().base, BaseType::U64);
        assert_eq!(amount.amount_mint(), Ok(ValueRef { source: ValueSource::Input, index: 2 }));
        assert!(interface.inputs().unwrap().get(4).unwrap().optional());
    }

    #[test]
    fn the_view_is_two_references() {
        assert_eq!(core::mem::size_of::<Interface>(), 3 * core::mem::size_of::<usize>());
    }
}
