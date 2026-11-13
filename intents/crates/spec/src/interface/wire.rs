//! The interface document as it is stored, and the decoders of its entries.

use bytemuck::{Pod, Zeroable};

use crate::{DocumentHeaderV1, DocumentIdV1, PoolRefV1, SpecError, TableRefV1, ValueRef, ValueRefV1, ValueType};

pub(crate) const INPUT_SIGNER: u8 = 1;
pub(crate) const INPUT_OPTIONAL: u8 = 2;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct InterfaceDocV1 {
    pub header: DocumentHeaderV1,
    pub id: DocumentIdV1,
    pub name: PoolRefV1,
    pub display: PoolRefV1,
    pub inputs: TableRefV1,
    pub outputs: TableRefV1,
    pub post_conditions: TableRefV1,
    pub addresses: TableRefV1,
    pub literals: TableRefV1,
    pub pool: PoolRefV1,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct InputV1 {
    pub name: PoolRefV1,
    pub value_type: u8,
    pub flags: u8,
    /// The mint for an `amount` display, or source `None`.
    pub amount_mint: ValueRefV1,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct OutputV1 {
    pub name: PoolRefV1,
    pub value_type: u8,
}

impl InputV1 {
    pub fn new(name: PoolRefV1, value_type: ValueType, signer: bool, optional: bool, amount_mint: ValueRefV1) -> Self {
        let flags = if signer { INPUT_SIGNER } else { 0 } | if optional { INPUT_OPTIONAL } else { 0 };

        Self { name, value_type: value_type.into(), flags, amount_mint }
    }

    pub fn signer(&self) -> bool {
        self.flags & INPUT_SIGNER != 0
    }

    pub fn optional(&self) -> bool {
        self.flags & INPUT_OPTIONAL != 0
    }

    pub fn value_type(&self) -> Result<ValueType, SpecError> {
        ValueType::try_from(self.value_type)
    }

    pub fn amount_mint(&self) -> Result<ValueRef, SpecError> {
        ValueRef::try_from(self.amount_mint)
    }
}

impl OutputV1 {
    pub fn value_type(&self) -> Result<ValueType, SpecError> {
        ValueType::try_from(self.value_type)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::size_of;

    #[test]
    fn layouts_are_pinned() {
        assert_eq!(size_of::<InputV1>(), 8);
        assert_eq!(size_of::<OutputV1>(), 5);
    }
}
