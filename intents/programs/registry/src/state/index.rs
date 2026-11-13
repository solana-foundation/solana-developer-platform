//! `VersionIndexV1`: the authorities, the head, and the versions of one interface or
//! implementation. Two lists follow the fixed part: the versions, sorted so that the last entry is
//! the newest, then the index addresses of the implementations that an interface approves.

use anchor_lang::prelude::*;
use bytemuck::{bytes_of, Pod, Zeroable};
use pinocchio::account::{Ref, RefMut};
use sdp_intents_spec::wire::{DocumentKind, PodBool, PodU32, PodU64, SemverV1};

use crate::error::RegistryError;
use crate::state::{compare_versions, owned_data, owned_data_mut};

#[account]
pub struct VersionIndexV1 {
    /// `DocumentKind::Interface` or `DocumentKind::Implementation`. It is a seed.
    pub kind: u8,
    pub organization: Address,
    pub name_hash: [u8; 32],
    pub update_authority: Address,
    /// Zero on an implementation index.
    pub approve_authority: Address,
    /// The interface's index, on an implementation index. It never changes.
    pub interface: Address,
    pub approve_new_versions: PodBool,
    pub has_head: PodBool,
    pub head: SemverV1,
    pub version_count: PodU32,
    pub approved_count: PodU32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct VersionEntryV1 {
    pub version: SemverV1,
    pub publish_slot: PodU64,
    pub approved: PodBool,
}

/// The discriminator and the fixed part.
pub const FIXED_LEN: usize = 8 + core::mem::size_of::<VersionIndexV1>();
pub const ENTRY_LEN: usize = core::mem::size_of::<VersionEntryV1>();
const APPROVED_LEN: usize = core::mem::size_of::<Address>();

/// A version index read in place.
#[derive(Clone, Copy)]
pub struct Index<'a> {
    pub header: &'a VersionIndexV1,
    pub versions: &'a [VersionEntryV1],
    pub approved: &'a [Address],
}

impl<'a> Index<'a> {
    /// The account must be exactly the fixed part and the two lists that the counts give.
    pub fn parse(data: &'a [u8]) -> Result<Self> {
        let header: &VersionIndexV1 =
            bytemuck::try_from_bytes(data.get(8..FIXED_LEN).ok_or(RegistryError::WrongAccount)?)
                .map_err(|_| RegistryError::WrongAccount)?;
        let versions_end = approved_offset(header.version_count.get(), 0)?;
        let end = approved_offset(header.version_count.get(), header.approved_count.get())?;

        require!(data.len() == end, RegistryError::WrongAccount);

        let versions = data.get(FIXED_LEN..versions_end).ok_or(RegistryError::WrongAccount)?;
        let approved = data.get(versions_end..end).ok_or(RegistryError::WrongAccount)?;

        Ok(Self {
            header,
            versions: bytemuck::try_cast_slice(versions).map_err(|_| RegistryError::WrongAccount)?,
            approved: bytemuck::try_cast_slice(approved).map_err(|_| RegistryError::WrongAccount)?,
        })
    }

    pub fn kind(&self) -> Result<DocumentKind> {
        DocumentKind::try_from(self.header.kind).map_err(|_| RegistryError::WrongAccount.into())
    }

    pub fn require_kind(&self, kind: DocumentKind) -> Result<()> {
        require!(self.kind()? == kind, RegistryError::WrongIndexKind);

        Ok(())
    }

    /// The position of `version`, or the position where it belongs.
    pub fn find(&self, version: &SemverV1) -> core::result::Result<usize, usize> {
        self.versions.binary_search_by(|entry| compare_versions(&entry.version, version))
    }

    pub fn entry(&self, version: &SemverV1) -> Option<&'a VersionEntryV1> {
        self.find(version).ok().and_then(|position| self.versions.get(position))
    }

    pub fn approves(&self, implementation_index: &Address) -> bool {
        self.approved.contains(implementation_index)
    }
}

pub fn load(view: &AccountView) -> Result<Ref<'_, [u8]>> {
    owned_data(view, VersionIndexV1::DISCRIMINATOR)
}

/// The fixed part, after the same checks as `Index::parse`.
pub fn header_mut(view: &mut AccountView) -> Result<RefMut<'_, VersionIndexV1>> {
    Index::parse(&load(view)?)?;

    header_during_change(view)
}

/// Adds `entry` in version order. `payer` funds the 15 bytes that the account grows by.
pub fn insert_version(view: &mut AccountView, payer: &AccountView, entry: VersionEntryV1) -> Result<()> {
    let placement = {
        let data = load(view)?;
        let index = Index::parse(&data)?;
        let position = index.find(&entry.version).err().ok_or(RegistryError::AlreadyPublished)?;

        Placement { position, len: data.len() }
    };

    let grown = placement.len.checked_add(ENTRY_LEN).ok_or(ProgramError::ArithmeticOverflow)?;
    anchor_lang::realloc_account(view, grown, payer, true)?;

    let start = entry_offset(placement.position)?;
    let mut data = view.try_borrow_mut()?;
    data.get_mut(start..grown).ok_or(RegistryError::WrongAccount)?.rotate_right(ENTRY_LEN);
    data.get_mut(start..)
        .and_then(|rest| rest.get_mut(..ENTRY_LEN))
        .ok_or(RegistryError::WrongAccount)?
        .copy_from_slice(bytes_of(&entry));

    drop(data);

    let mut header = header_during_change(view)?;
    header.version_count = add(header.version_count, 1)?;

    Ok(())
}

/// Takes out the entry at `position`. The rent of its 15 bytes goes to `recipient`.
pub fn remove_version(view: &mut AccountView, recipient: &AccountView, position: usize) -> Result<()> {
    let len = {
        let data = load(view)?;
        Index::parse(&data)?.versions.get(position).ok_or(RegistryError::VersionNotPublished)?;

        data.len()
    };

    let start = entry_offset(position)?;
    let mut data = view.try_borrow_mut()?;
    data.get_mut(start..len).ok_or(RegistryError::WrongAccount)?.rotate_left(ENTRY_LEN);
    drop(data);

    let mut header = header_during_change(view)?;
    header.version_count = sub(header.version_count, 1)?;
    drop(header);

    let shrunk = len.checked_sub(ENTRY_LEN).ok_or(ProgramError::ArithmeticOverflow)?;

    anchor_lang::realloc_account(view, shrunk, recipient, false)
}

pub fn set_version_approved(view: &mut AccountView, version: &SemverV1, approved: bool) -> Result<()> {
    let position = {
        let data = load(view)?;

        Index::parse(&data)?.find(version).map_err(|_| RegistryError::VersionNotPublished)?
    };

    let mut data = view.try_borrow_mut()?;
    let entry = data.get_mut(entry_offset(position)?..).and_then(|rest| rest.get_mut(..ENTRY_LEN));
    let entry: &mut VersionEntryV1 = bytemuck::try_from_bytes_mut(entry.ok_or(RegistryError::WrongAccount)?)
        .map_err(|_| RegistryError::WrongAccount)?;
    entry.approved = PodBool::new(approved);

    Ok(())
}

/// Appends an implementation index to an interface's approved list. `payer` funds 32 bytes.
pub fn push_approved(view: &mut AccountView, payer: &AccountView, implementation_index: &Address) -> Result<()> {
    let len = {
        let data = load(view)?;
        let index = Index::parse(&data)?;

        require!(!index.approves(implementation_index), RegistryError::AlreadyApproved);

        data.len()
    };

    let grown = len.checked_add(APPROVED_LEN).ok_or(ProgramError::ArithmeticOverflow)?;
    anchor_lang::realloc_account(view, grown, payer, true)?;

    let mut data = view.try_borrow_mut()?;
    data.get_mut(len..grown).ok_or(RegistryError::WrongAccount)?.copy_from_slice(implementation_index.as_ref());
    drop(data);

    let mut header = header_during_change(view)?;
    header.approved_count = add(header.approved_count, 1)?;

    Ok(())
}

/// Moves the last approved address into the gap of `implementation_index`, then shrinks. The rent
/// of the 32 bytes goes to `recipient`.
pub fn remove_approved(view: &mut AccountView, recipient: &AccountView, implementation_index: &Address) -> Result<()> {
    let gap = {
        let data = load(view)?;
        let index = Index::parse(&data)?;
        let position = index.approved.iter().position(|approved| approved == implementation_index);
        let position = position.ok_or(RegistryError::NotApproved)?;

        Gap { offset: approved_offset(index.header.version_count.get(), u32_from(position)?)?, len: data.len() }
    };

    let last_start = gap.len.checked_sub(APPROVED_LEN).ok_or(ProgramError::ArithmeticOverflow)?;
    let mut data = view.try_borrow_mut()?;
    let last: [u8; APPROVED_LEN] =
        data.get(last_start..gap.len).and_then(|last| last.try_into().ok()).ok_or(RegistryError::WrongAccount)?;
    data.get_mut(gap.offset..)
        .and_then(|rest| rest.get_mut(..APPROVED_LEN))
        .ok_or(RegistryError::WrongAccount)?
        .copy_from_slice(&last);

    drop(data);

    let mut header = header_during_change(view)?;
    header.approved_count = sub(header.approved_count, 1)?;
    drop(header);

    anchor_lang::realloc_account(view, last_start, recipient, false)
}

/// Where a new entry goes, and the account length before the change.
struct Placement {
    position: usize,
    len: usize,
}

/// The byte offset of the address that `remove_approved` takes out, and the account length.
struct Gap {
    offset: usize,
    len: usize,
}

/// The fixed part without the length checks, because a change resizes the account before it updates
/// the counts.
fn header_during_change(view: &mut AccountView) -> Result<RefMut<'_, VersionIndexV1>> {
    let data = owned_data_mut(view, VersionIndexV1::DISCRIMINATOR)?;

    RefMut::try_map(data, |data| {
        data.get_mut(8..FIXED_LEN).and_then(|bytes| bytemuck::try_from_bytes_mut(bytes).ok()).ok_or(())
    })
    .map_err(|_| RegistryError::WrongAccount.into())
}

fn entry_offset(position: usize) -> Result<usize> {
    position
        .checked_mul(ENTRY_LEN)
        .and_then(|offset| offset.checked_add(FIXED_LEN))
        .ok_or(ProgramError::ArithmeticOverflow)
}

fn approved_offset(version_count: u32, approved_position: u32) -> Result<usize> {
    let versions = usize::try_from(version_count).map_err(|_| ProgramError::ArithmeticOverflow)?;
    let approved = usize::try_from(approved_position).map_err(|_| ProgramError::ArithmeticOverflow)?;

    approved
        .checked_mul(APPROVED_LEN)
        .and_then(|offset| offset.checked_add(entry_offset(versions).ok()?))
        .ok_or(ProgramError::ArithmeticOverflow)
}

fn u32_from(value: usize) -> Result<u32> {
    u32::try_from(value).map_err(|_| ProgramError::ArithmeticOverflow)
}

fn add(count: PodU32, value: u32) -> Result<PodU32> {
    count.get().checked_add(value).map(PodU32::new).ok_or(ProgramError::ArithmeticOverflow)
}

fn sub(count: PodU32, value: u32) -> Result<PodU32> {
    count.get().checked_sub(value).map(PodU32::new).ok_or(ProgramError::ArithmeticOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_are_pinned() {
        assert_eq!(core::mem::size_of::<VersionIndexV1>(), 177);
        assert_eq!(ENTRY_LEN, 15);
        assert_eq!(FIXED_LEN, 185);
    }

    fn entry(minor: u16, approved: bool) -> VersionEntryV1 {
        VersionEntryV1 {
            version: crate::state::semver(1, minor, 0),
            publish_slot: PodU64::new(9),
            approved: PodBool::new(approved),
        }
    }

    fn index_bytes(versions: &[VersionEntryV1], approved: &[Address]) -> Vec<u8> {
        let count = |len: usize| PodU32::new(u32::try_from(len).unwrap_or(u32::MAX));
        let header = VersionIndexV1 {
            version_count: count(versions.len()),
            approved_count: count(approved.len()),
            ..VersionIndexV1::zeroed()
        };

        [&[0u8; 8][..], bytes_of(&header), bytemuck::cast_slice(versions), bytemuck::cast_slice(approved)].concat()
    }

    #[test]
    fn reads_both_lists_in_place() {
        let approved = [Address::new_from_array([4; 32])];
        let bytes = index_bytes(&[entry(0, true), entry(2, false)], &approved);
        let index = Index::parse(&bytes).unwrap();

        assert_eq!(index.versions.len(), 2);
        assert_eq!(index.find(&crate::state::semver(1, 2, 0)), Ok(1));
        assert_eq!(index.find(&crate::state::semver(1, 1, 0)), Err(1));
        assert!(index.entry(&crate::state::semver(1, 0, 0)).unwrap().approved.get());
        assert!(index.approves(&approved[0]));
    }

    #[test]
    fn refuses_lists_that_the_counts_do_not_give() {
        let mut bytes = index_bytes(&[entry(0, true)], &[]);
        bytes.push(0);

        assert!(Index::parse(&bytes).is_err());
        assert!(Index::parse(&bytes[..FIXED_LEN]).is_err());
    }
}
