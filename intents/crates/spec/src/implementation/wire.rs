//! The implementation document as it is stored: the fixed part, the entry types, and their codes.

use bytemuck::{Pod, Zeroable};

use crate::code::wire_code;
use crate::{Address, DocumentHeaderV1, DocumentIdV1, PoolRefV1, RangeV1, TableRefV1, ValueRefV1};

wire_code! {
    pub enum RecipeKind {
        Static = 1,
        Program = 2,
        /// An endpoint that returns instructions.
        Remote = 3,
        /// An endpoint that returns a whole transaction, which the provider signed (`DESIGN.md`, 4.16).
        RemoteTransaction = 4,
        /// A spend of a privacy ring's notes (`DESIGN.md`, 4.17). Each instruction is an output note:
        /// its program is the pool, its one account is the note's owner, and its segments are the
        /// asset, the amount, and the note's data. The first account is the spender.
        Shielded = 5,
        /// Steps that each name an interface (`DESIGN.md`, 4.19). Its tables are in the extension
        /// area, from spec 1.1.
        Flow = 6,
    }
}

impl RecipeKind {
    /// The trust tier of `DESIGN.md`, 4.16: 1 when `verify_intent` rebuilds the instructions, 2 when
    /// only the assertions bound them, and 3 when only a simulation checks them. A shielded spend is 3
    /// until the signer's verifier checks its notes. A flow adds no trust to its steps, each of
    /// which has its own tier.
    pub fn tier(self) -> u8 {
        match self {
            Self::Static | Self::Program | Self::Flow => 1,
            Self::Remote => 2,
            Self::RemoteTransaction | Self::Shielded => 3,
        }
    }
}

wire_code! {
    pub enum AccountSourceKind {
        Value = 1,
        Static = 2,
        Pda = 3,
        Ata = 4,
        HasOne = 5,
    }
}

wire_code! {
    pub enum SegmentSourceKind {
        Literal = 1,
        Reference = 2,
        AccountBytes = 3,
    }
}

wire_code! {
    pub enum Encoding {
        U8 = 1,
        U16Le = 2,
        U32Le = 3,
        U64Le = 4,
        U128Le = 5,
        I8 = 6,
        I16Le = 7,
        I32Le = 8,
        I64Le = 9,
        I128Le = 10,
        Bool = 11,
        Address = 12,
        Utf8 = 13,
        Borsh = 14,
    }
}

wire_code! {
    pub enum AppliesKind {
        Owner = 1,
        InputPresent = 2,
        InputAbsent = 3,
        InputEquals = 4,
    }
}

pub(crate) const ACCOUNT_WRITABLE: u8 = 1;
pub(crate) const ACCOUNT_SIGNER: u8 = 2;
pub(crate) const MAX_ACCOUNT_BYTES: u8 = 32;
pub(crate) const MAX_DISCRIMINATOR: u8 = 8;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct ImplementationDocV1 {
    pub header: DocumentHeaderV1,
    pub id: DocumentIdV1,
    /// The interface and the lowest version of it that this implementation implements.
    pub implements: DocumentIdV1,
    /// The genesis hash of the cluster whose programs the implementation names.
    pub cluster: Address,
    pub recipe_kind: u8,
    pub name: PoolRefV1,
    pub message: PoolRefV1,
    pub url: PoolRefV1,
    pub applies: TableRefV1,
    pub post_conditions: TableRefV1,
    pub addresses: TableRefV1,
    pub accounts: TableRefV1,
    pub seeds: TableRefV1,
    pub instructions: TableRefV1,
    pub instruction_accounts: TableRefV1,
    pub segments: TableRefV1,
    pub output_bindings: TableRefV1,
    pub literals: TableRefV1,
    pub pool: PoolRefV1,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct AppliesV1 {
    pub kind: u8,
    pub value: ValueRefV1,
    /// An address index: the owner for an owner check, and the expected value for `InputEquals`.
    pub owner: u8,
    pub discriminator_len: u8,
    pub discriminator: [u8; 8],
}

/// `payload` holds the source data, laid out as `AddressSource` reads it.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct AccountV1 {
    pub name: PoolRefV1,
    pub flags: u8,
    pub source: u8,
    pub payload: [u8; 6],
}

/// One entry of the segments table or the seeds table. `payload` holds the source data, laid out
/// as `Segment` reads it.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct SegmentV1 {
    pub source: u8,
    pub encoding: u8,
    pub payload: [u8; 6],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct InstructionV1 {
    /// An account index.
    pub program: u8,
    /// A range of the instruction accounts table.
    pub accounts: RangeV1,
    pub segments: RangeV1,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct OutputBindingV1 {
    pub output: u8,
    pub account: u8,
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::size_of;

    #[test]
    fn entry_layouts_are_pinned() {
        assert_eq!(size_of::<AppliesV1>(), 13);
        assert_eq!(size_of::<AccountV1>(), 12);
        assert_eq!(size_of::<SegmentV1>(), 8);
        assert_eq!(size_of::<InstructionV1>(), 5);
        assert_eq!(size_of::<OutputBindingV1>(), 2);
    }

    #[test]
    fn implements_is_at_byte_81() {
        assert_eq!(core::mem::offset_of!(ImplementationDocV1, implements), 81);
    }
}
