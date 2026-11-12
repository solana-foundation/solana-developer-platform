use bytemuck::{Pod, Zeroable};

use crate::code::wire_code;
use crate::{PodU16, SpecError};

/// A byte range of the pool, from the start of the pool.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct PoolRefV1 {
    pub offset: PodU16,
    pub len: PodU16,
}

/// A table of `count` fixed-size entries, from the start of the document.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct TableRefV1 {
    pub offset: PodU16,
    pub count: u8,
}

/// A run of `count` entries of another table, starting at `first`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct RangeV1 {
    pub first: u8,
    pub count: u8,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct ValueRefV1 {
    pub source: u8,
    pub index: u8,
}

wire_code! {
    pub enum ValueSource {
        None = 0,
        Input = 1,
        Output = 2,
        /// Index `0` is the fee payer and `1` is the rent payer.
        Payer = 3,
        Account = 4,
        Address = 5,
        Literal = 6,
    }
}

/// A decoded `ValueRefV1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ValueRef {
    pub source: ValueSource,
    pub index: u8,
}

impl TryFrom<ValueRefV1> for ValueRef {
    type Error = SpecError;

    fn try_from(wire: ValueRefV1) -> Result<Self, Self::Error> {
        Ok(Self { source: ValueSource::try_from(wire.source)?, index: wire.index })
    }
}

impl ValueRef {
    pub(crate) fn from_bytes(bytes: [u8; 2]) -> Result<Self, SpecError> {
        let [source, index] = bytes;

        Self::try_from(ValueRefV1 { source, index })
    }
}

impl RangeV1 {
    /// The range as indexes of a table with `len` entries.
    pub(crate) fn within(self, len: usize) -> Result<core::ops::Range<usize>, SpecError> {
        let start = usize::from(self.first);
        let end = start.checked_add(usize::from(self.count)).ok_or(SpecError::OutOfBounds)?;

        if end > len {
            return Err(SpecError::OutOfBounds);
        }

        Ok(start..end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_ref_decodes_its_source() {
        let value = ValueRef::from_bytes([3, 1]).unwrap();

        assert_eq!(value, ValueRef { source: ValueSource::Payer, index: 1 });
        assert_eq!(ValueRef::from_bytes([9, 0]), Err(SpecError::BadCode));
    }

    #[test]
    fn range_stays_inside_its_table() {
        assert_eq!(RangeV1 { first: 1, count: 2 }.within(3), Ok(1..3));
        assert_eq!(RangeV1 { first: 2, count: 2 }.within(3), Err(SpecError::OutOfBounds));
    }
}
