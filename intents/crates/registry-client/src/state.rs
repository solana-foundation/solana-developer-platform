//! Views of the registry's accounts, read in place. Each struct repeats the layout of the
//! registry's own, and the registry's tests pin their sizes against it.

use bytemuck::{Pod, Zeroable};

use sdp_intents_spec::wire::{DocumentKind, PodBool, PodU32, PodU64, SemverV1};
use sdp_intents_spec::Address;

use crate::RegistryError;

/// A version account holds the 8-byte discriminator, the version, and the publish slot, then the
/// document.
pub const VERSION_DOCUMENT_OFFSET: usize = 8 + 6 + 8;
const DISCRIMINATOR_LEN: usize = 8;

/// The Anchor discriminator of each account: the first 8 bytes of `sha256("account:<name>")`.
pub const ORGANIZATION_DISCRIMINATOR: [u8; 8] = [179, 162, 27, 240, 122, 53, 153, 129];
pub const INDEX_DISCRIMINATOR: [u8; 8] = [177, 63, 132, 129, 187, 8, 159, 245];
pub const INTERFACE_DISCRIMINATOR: [u8; 8] = [57, 128, 27, 73, 123, 154, 34, 182];
pub const IMPLEMENTATION_DISCRIMINATOR: [u8; 8] = [65, 167, 68, 231, 67, 72, 161, 41];

const MAX_ORGANIZATION_NAME: usize = 64;
const INDEX_LISTS_OFFSET: usize = DISCRIMINATOR_LEN + size_of::<VersionIndexV1>();

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct OrganizationV1 {
    authority: Address,
    name_hash: [u8; 32],
    name_len: u8,
    name: [u8; MAX_ORGANIZATION_NAME],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct VersionIndexV1 {
    kind: u8,
    organization: Address,
    name_hash: [u8; 32],
    update_authority: Address,
    approve_authority: Address,
    interface: Address,
    approve_new_versions: PodBool,
    has_head: PodBool,
    head: SemverV1,
    version_count: PodU32,
    approved_count: PodU32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct VersionEntryV1 {
    version: SemverV1,
    publish_slot: PodU64,
    approved: PodBool,
    removed: PodBool,
    tier: u8,
}

pub struct OrganizationView<'a> {
    fixed: &'a OrganizationV1,
}

impl<'a> OrganizationView<'a> {
    pub fn parse(data: &'a [u8]) -> Result<Self, RegistryError> {
        Ok(Self { fixed: fixed(data, &ORGANIZATION_DISCRIMINATOR)? })
    }

    pub fn authority(&self) -> &'a Address {
        &self.fixed.authority
    }

    pub fn name(&self) -> Result<&'a str, RegistryError> {
        let name = self.fixed.name.get(..usize::from(self.fixed.name_len)).ok_or(RegistryError::WrongAccount)?;

        core::str::from_utf8(name).map_err(|_| RegistryError::WrongAccount)
    }
}

/// An index: the fixed part, then each version's entry in version order, then the address of each
/// approved implementation index.
pub struct IndexView<'a> {
    fixed: &'a VersionIndexV1,
    versions: &'a [VersionEntryV1],
    approved: &'a [Address],
}

/// What an index holds about one version.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VersionEntry {
    pub version: SemverV1,
    pub publish_slot: u64,
    pub approved: bool,
    pub removed: bool,
    pub tier: u8,
}

impl From<&VersionEntryV1> for VersionEntry {
    fn from(entry: &VersionEntryV1) -> Self {
        Self {
            version: entry.version,
            publish_slot: entry.publish_slot.get(),
            approved: entry.approved.get(),
            removed: entry.removed.get(),
            tier: entry.tier,
        }
    }
}

impl<'a> IndexView<'a> {
    /// The account must be exactly the fixed part and the two lists that the counts give.
    pub fn parse(data: &'a [u8]) -> Result<Self, RegistryError> {
        let fixed: &VersionIndexV1 = fixed(data, &INDEX_DISCRIMINATOR)?;
        let lists = data.get(INDEX_LISTS_OFFSET..).ok_or(RegistryError::WrongAccount)?;
        let count = |value: PodU32| usize::try_from(value.get()).map_err(|_| RegistryError::WrongAccount);
        let versions_len =
            count(fixed.version_count)?.checked_mul(size_of::<VersionEntryV1>()).ok_or(RegistryError::WrongAccount)?;
        let (versions, approved) = lists.split_at_checked(versions_len).ok_or(RegistryError::WrongAccount)?;

        let index = Self {
            fixed,
            versions: bytemuck::try_cast_slice(versions).map_err(|_| RegistryError::WrongAccount)?,
            approved: bytemuck::try_cast_slice(approved).map_err(|_| RegistryError::WrongAccount)?,
        };

        if index.approved.len() != count(fixed.approved_count)? {
            return Err(RegistryError::WrongAccount);
        }

        Ok(index)
    }

    pub fn kind(&self) -> Result<DocumentKind, RegistryError> {
        DocumentKind::try_from(self.fixed.kind).map_err(|_| RegistryError::WrongAccount)
    }

    pub fn organization(&self) -> &'a Address {
        &self.fixed.organization
    }

    pub fn name_hash(&self) -> &'a [u8; 32] {
        &self.fixed.name_hash
    }

    /// The interface's index, on an implementation index.
    pub fn interface(&self) -> &'a Address {
        &self.fixed.interface
    }

    /// Each version, oldest first.
    pub fn versions(&self) -> impl Iterator<Item = VersionEntry> + 'a {
        self.versions.iter().map(VersionEntry::from)
    }

    /// The index address of each implementation that an interface approves.
    pub fn approved(&self) -> &'a [Address] {
        self.approved
    }

    pub fn update_authority(&self) -> &'a Address {
        &self.fixed.update_authority
    }

    pub fn approve_authority(&self) -> &'a Address {
        &self.fixed.approve_authority
    }

    pub fn head(&self) -> Option<SemverV1> {
        self.fixed.has_head.get().then_some(self.fixed.head)
    }

    pub fn approve_new_versions(&self) -> bool {
        self.fixed.approve_new_versions.get()
    }

    pub fn approves(&self, implementation_index: &Address) -> bool {
        self.approved.contains(implementation_index)
    }

    pub fn entry(&self, version: &SemverV1) -> Option<VersionEntry> {
        self.versions.iter().find(|entry| entry.version == *version).map(VersionEntry::from)
    }
}

/// The fixed part after the discriminator.
fn fixed<'a, T: Pod>(data: &'a [u8], discriminator: &[u8; 8]) -> Result<&'a T, RegistryError> {
    if !data.starts_with(discriminator) {
        return Err(RegistryError::WrongAccount);
    }

    let end = DISCRIMINATOR_LEN.checked_add(size_of::<T>()).ok_or(RegistryError::WrongAccount)?;
    let bytes = data.get(DISCRIMINATOR_LEN..end).ok_or(RegistryError::WrongAccount)?;

    bytemuck::try_from_bytes(bytes).map_err(|_| RegistryError::WrongAccount)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_are_pinned() {
        assert_eq!(size_of::<OrganizationV1>(), 129);
        assert_eq!(size_of::<VersionIndexV1>(), 177);
        assert_eq!(size_of::<VersionEntryV1>(), 17);
    }
}
