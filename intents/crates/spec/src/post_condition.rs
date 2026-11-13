use bytemuck::{Pod, Zeroable};

use crate::code::wire_code;
use crate::{PoolRefV1, RangeV1, ValueRefV1};

wire_code! {
    pub enum CheckKind {
        Outflow = 1,
        Inflow = 2,
        NoOtherOutflows = 3,
        NoAuthorityChange = 4,
        /// Only an implementation can state it, because an interface names no programs.
        InvokesOnly = 5,
        /// The owner's token accounts of a mint have the delegate, for at most an amount.
        Delegates = 6,
        /// The owner's token accounts of a mint have no delegate.
        NoDelegate = 7,
    }
}

/// `args` are `from`, `mint`, and `max` for an outflow, `to`, `mint`, and `min` for an inflow,
/// `from`, `mint`, and `max` for a delegation, and the account first for the other checks. An unused
/// argument has source `None`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct PostConditionV1 {
    pub check: u8,
    pub args: [ValueRefV1; 3],
    /// A range of the addresses table, for `InvokesOnly`. A `Delegates` holds its delegate here, as
    /// a `ValueRefV1` of the same two bytes, because it needs a fourth value.
    pub programs: RangeV1,
    pub message: PoolRefV1,
}

impl PostConditionV1 {
    /// The delegate of a `Delegates` check.
    pub fn delegate(&self) -> ValueRefV1 {
        ValueRefV1 { source: self.programs.first, index: self.programs.count }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_pinned() {
        assert_eq!(core::mem::size_of::<PostConditionV1>(), 13);
    }
}
