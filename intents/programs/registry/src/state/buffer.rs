//! A document on its way to `publish`: the key that writes it, the length, then the bytes. Its
//! address is the PDA of `"buffer"`, the writer, and a `u32` that the writer picks.

use anchor_lang::prelude::*;

use crate::state::wire::PodU16;

#[account]
pub struct BufferV1 {
    pub authority: Address,
    pub document_len: PodU16,
}

/// The discriminator and the fixed part.
pub const FIXED_LEN: usize = 8 + core::mem::size_of::<BufferV1>();

/// The largest document, so that a version account fits the 10,240 bytes that one CPI can
/// allocate. `compiler/src/limits.rs` holds the same limit.
pub const MAX_DOCUMENT_LEN: usize = 10_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_pinned() {
        assert_eq!(core::mem::size_of::<BufferV1>(), 34);
        assert_eq!(FIXED_LEN, 42);
    }
}
