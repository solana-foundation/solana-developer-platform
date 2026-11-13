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
    }
}

/// `args` are `from`, `mint`, and `max` for an outflow, `to`, `mint`, and `min` for an inflow, and
/// the account first for the other checks. An unused argument has source `None`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct PostConditionV1 {
    pub check: u8,
    pub args: [ValueRefV1; 3],
    /// A range of the addresses table, for `InvokesOnly`.
    pub programs: RangeV1,
    pub message: PoolRefV1,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_pinned() {
        assert_eq!(core::mem::size_of::<PostConditionV1>(), 13);
    }
}
