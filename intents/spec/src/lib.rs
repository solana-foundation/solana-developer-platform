//! Wire format of SDP intents.
//!
//! Every document is alignment-1 pod: a header, a fixed part, tables of fixed-size entries, a byte
//! pool, and an extension area. A `TableRefV1` and the pool's `PoolRefV1` are byte offsets from the
//! start of the document. A `PoolRefV1` inside an entry is an offset from the start of the pool.
//!
//! A view such as [`Implementation`] holds two references into the document bytes. Its accessors
//! return entries in place as `&[AccountV1]` and the like, and a wire struct decodes its variant
//! into a small `Copy` enum on demand. Nothing allocates. `parse` validates every table, code,
//! index, and range once. The accessors still return `Result`, so that no path can panic, but after
//! a successful `parse` they always return `Ok`.
//!
//! The design is in `packages/sdp-intents/DESIGN.md`, section 4.9.

#![cfg_attr(not(test), no_std)]

mod address;
mod code;
mod document;
mod error;
mod implementation;
mod pod;
mod refs;
mod region;

#[cfg(test)]
mod test_support;

pub use address::Address;
pub use document::{DocumentHeaderV1, DocumentIdV1, DocumentKind, SemverV1, MAGIC, SPEC_MAJOR, SPEC_MINOR};
pub use error::SpecError;
pub use implementation::{
    AccountSourceKind, AccountV1, AddressSource, AppliesKind, AppliesV1, CheckKind, Encoding, Implementation,
    ImplementationDocV1, InstructionV1, LiteralV1, OutputBindingV1, PostConditionV1, RecipeKind, Segment,
    SegmentSourceKind, SegmentV1,
};
pub use pod::{PodBool, PodU16, PodU32, PodU64};
pub use refs::{PoolRefV1, RangeV1, TableRefV1, ValueRef, ValueRefV1, ValueSource};
