//! The account of one published version: the fixed part, then the document in its binary form. The
//! registry validated the document at `publish`, and a version account never changes.

use anchor_lang::prelude::*;
use pinocchio::account::Ref;
use sdp_intents_spec::wire::{DocumentIdV1, DocumentKind};
use sdp_intents_spec::{Implementation, Interface};

use crate::error::RegistryError;
use crate::state::owned_data;
use crate::state::wire::{PodU64, SemverV1};

#[account]
pub struct InterfaceV1 {
    pub version: SemverV1,
    pub publish_slot: PodU64,
}

#[account]
pub struct ImplementationV1 {
    pub version: SemverV1,
    pub publish_slot: PodU64,
}

/// The discriminator and the fixed part, which both kinds share.
pub const FIXED_LEN: usize = 8 + core::mem::size_of::<InterfaceV1>();

const _: () = assert!(core::mem::size_of::<InterfaceV1>() == core::mem::size_of::<ImplementationV1>());

pub fn discriminator(kind: DocumentKind) -> Result<&'static [u8]> {
    match kind {
        DocumentKind::Interface => Ok(InterfaceV1::DISCRIMINATOR),
        DocumentKind::Implementation => Ok(ImplementationV1::DISCRIMINATOR),
        DocumentKind::Intent => Err(RegistryError::WrongIndexKind.into()),
    }
}

pub fn seed(kind: DocumentKind) -> Result<&'static [u8]> {
    match kind {
        DocumentKind::Interface => Ok(crate::state::INTERFACE_SEED),
        DocumentKind::Implementation => Ok(crate::state::IMPLEMENTATION_SEED),
        DocumentKind::Intent => Err(RegistryError::WrongIndexKind.into()),
    }
}

/// The account data of a version of `kind`. [`document`] reads the document from it.
pub fn load(view: &AccountView, kind: DocumentKind) -> Result<Ref<'_, [u8]>> {
    owned_data(view, discriminator(kind)?)
}

pub fn document(data: &[u8]) -> Result<&[u8]> {
    Ok(data.get(FIXED_LEN..).ok_or(RegistryError::WrongAccount)?)
}

/// The id that a document of `kind` holds.
pub fn document_id(kind: DocumentKind, document: &[u8]) -> Result<&DocumentIdV1> {
    let id = match kind {
        DocumentKind::Interface => Interface::parse(document).map(|interface| interface.id()),
        DocumentKind::Implementation => Implementation::parse(document).map(|implementation| implementation.id()),
        DocumentKind::Intent => return Err(RegistryError::WrongIndexKind.into()),
    };

    id.map_err(|_| RegistryError::BadDocument.into())
}

/// The seeds of a version account, without the bump: the kind's seed, the organization, the name
/// hash, then the major, minor, and patch as little-endian `u16`.
pub struct VersionSeeds {
    pub major: [u8; 2],
    pub minor: [u8; 2],
    pub patch: [u8; 2],
}

impl VersionSeeds {
    pub fn new(version: &SemverV1) -> Self {
        Self {
            major: version.major.get().to_le_bytes(),
            minor: version.minor.get().to_le_bytes(),
            patch: version.patch.get().to_le_bytes(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_pinned() {
        assert_eq!(core::mem::size_of::<InterfaceV1>(), 14);
        assert_eq!(core::mem::size_of::<ImplementationV1>(), 14);
        assert_eq!(FIXED_LEN, 22);
    }
}
