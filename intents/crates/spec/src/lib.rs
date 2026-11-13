//! The binary form of SDP intents: interfaces, implementations, and intents.
//!
//! Read a document with its view. [`Interface::parse`], [`Implementation::parse`], and
//! [`Intent::parse`] validate the bytes once, then each accessor returns entries in place. An entry
//! decodes its variant on demand into a small `Copy` value, such as [`AddressSource`] or
//! [`Segment`]. Nothing allocates, so a program can read a document inside its 4 KB stack frame.
//!
//! ```
//! use sdp_intents_spec::{AddressSource, Implementation, SpecError};
//!
//! fn count_derived_accounts(bytes: &[u8]) -> Result<usize, SpecError> {
//!     let implementation = Implementation::parse(bytes)?;
//!     let mut derived = 0;
//!
//!     for account in implementation.accounts()? {
//!         if let AddressSource::Pda { .. } | AddressSource::Ata { .. } = account.address()? {
//!             derived += 1;
//!         }
//!     }
//!
//!     Ok(derived)
//! }
//! ```
//!
//! [`wire`] holds the stored layouts, which a writer such as `sdp-intents-compiler` lays out.
//! [`builder`] holds what a builder program returns. The design is in
//! `packages/sdp-intents/DESIGN.md`, sections 4.2 and 4.9.

#![cfg_attr(not(test), no_std)]

mod address;
pub mod builder;
pub mod cluster;
mod code;
mod counts;
mod document;
mod error;
mod implementation;
mod intent;
mod interface;
mod literal;
mod pod;
mod post_condition;
mod refs;
mod region;
mod role;
mod value_type;

#[cfg(test)]
mod test_support;

pub use address::Address;
pub use error::SpecError;
pub use implementation::{AddressSource, AppliesKind, Encoding, Implementation, RecipeKind, Segment};
pub use intent::{Intent, IntentOptions};
pub use interface::Interface;
pub use post_condition::CheckKind;
pub use refs::{ValueRef, ValueSource};
pub use role::AccountRole;
pub use value_type::{BaseType, ValueType};

/// The stored layout of each document: the fixed parts, the entry types, and the integers they
/// hold. A view returns these entries in place. A writer, such as the compiler, lays them out.
pub mod wire {
    pub use crate::document::{DocumentHeaderV1, DocumentIdV1, DocumentKind, SemverV1, MAGIC, SPEC_MAJOR, SPEC_MINOR};
    pub use crate::implementation::{
        AccountV1, AppliesV1, ImplementationDocV1, InstructionV1, OutputBindingV1, SegmentV1,
    };
    pub use crate::intent::IntentDocV1;
    pub use crate::interface::{InputV1, InterfaceDocV1, OutputV1, INTERFACE_SETTLES_LATER};
    pub use crate::literal::LiteralV1;
    pub use crate::pod::{PodBool, PodU16, PodU32, PodU64};
    pub use crate::post_condition::PostConditionV1;
    pub use crate::refs::{PoolRefV1, RangeV1, TableRefV1, ValueRefV1};
}

// The modules of this crate name the wire types from the root.
#[cfg(test)]
pub(crate) use implementation::{AccountSourceKind, SegmentSourceKind};
pub(crate) use wire::*;
