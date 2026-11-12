use bytemuck::{Pod, Zeroable};

use crate::PoolRefV1;

/// A literal value that a `ValueRefV1` with source `Literal` names. `bytes` hold the value in
/// `borsh`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct LiteralV1 {
    pub value_type: u8,
    pub bytes: PoolRefV1,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_pinned() {
        assert_eq!(core::mem::size_of::<LiteralV1>(), 5);
    }
}
