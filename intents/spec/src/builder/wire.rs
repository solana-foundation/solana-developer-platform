//! The builder results as they are stored. `DESIGN.md`, section 4.2, gives the layout of each.

use bytemuck::{Pod, Zeroable};

use crate::code::wire_code;
use crate::{Address, PodU16, PodU32};

/// The rent payer in a built instruction. No instruction names the fee payer, because the runtime
/// charges the fee.
pub const PAYER_RENT_PLACEHOLDER: Address = Address(*b"sdp-intents/payer/rent\0\0\0\0\0\0\0\0\0\0");

/// Return data holds at most 1,024 bytes. `HashedReadyV1` takes 36 of them.
pub const MAX_HASHED_TAIL: usize = 988;

wire_code! {
    pub enum ResultKind {
        Ready = 1,
        MoreAccounts = 2,
        Refused = 3,
        HashedReady = 4,
    }
}

/// The return data of a staged builder. The result is `len` bytes at `offset` in the scratch
/// account, which is account `account_index` of the builder instruction.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct ResultPointerV1 {
    pub kind: u8,
    pub account_index: u8,
    pub offset: PodU32,
    pub len: PodU32,
}

/// The start of a `Ready` result. The outputs follow, then 32 bytes for each signer, then the
/// instruction section.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct ReadyHeaderV1 {
    pub num_instructions: u8,
    pub num_signers: u8,
    pub outputs_len: PodU16,
}

/// The start of one instruction in the instruction section. `num_accounts` entries of
/// `AccountMetaV1` follow, then `data_len` bytes of data.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct InstructionHeaderV1 {
    pub program: Address,
    pub num_accounts: u8,
    pub data_len: PodU16,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct AccountMetaV1 {
    pub address: Address,
    pub role: u8,
}

/// The return data of a builder under CPI. 32 bytes for each signer follow, then the outputs.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct HashedReadyV1 {
    pub kind: u8,
    /// The SHA-256 of the instruction section, with the rent placeholder in place.
    pub instructions_hash: [u8; 32],
    pub num_signers: u8,
    pub outputs_len: PodU16,
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::size_of;

    #[test]
    fn layouts_are_pinned() {
        assert_eq!(size_of::<ResultPointerV1>(), 10);
        assert_eq!(size_of::<ReadyHeaderV1>(), 4);
        assert_eq!(size_of::<InstructionHeaderV1>(), 35);
        assert_eq!(size_of::<AccountMetaV1>(), 33);
        assert_eq!(size_of::<HashedReadyV1>(), 36);
    }
}
