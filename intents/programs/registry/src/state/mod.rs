//! The accounts of the registry. Each one starts with its 8-byte Anchor discriminator.
//!
//! An organization and a buffer header have a fixed size. A version index and a version account
//! have a tail after the fixed part, so the registry reads them in place with its own views. Each
//! view checks the owner, the discriminator, and the length of the tail before it returns.

pub mod buffer;
pub mod index;
pub mod organization;
pub mod version;
pub mod wire;

use anchor_lang::prelude::*;

use crate::error::RegistryError;
use pinocchio::account::{Ref, RefMut};
use wire::SemverV1;
pub use wire::{semver, stored_version};

pub const ORGANIZATION_SEED: &[u8] = b"org";
pub const INDEX_SEED: &[u8] = b"index";
pub const INTERFACE_SEED: &[u8] = b"interface";
pub const IMPLEMENTATION_SEED: &[u8] = b"implementation";
pub const BUFFER_SEED: &[u8] = b"buffer";

/// The data of an account that the registry owns and that starts with `discriminator`.
pub(crate) fn owned_data<'a>(view: &'a AccountView, discriminator: &[u8]) -> Result<Ref<'a, [u8]>> {
    require!(view.owned_by(&crate::ID), RegistryError::WrongAccount);

    let data = view.try_borrow()?;
    require!(data.get(..discriminator.len()) == Some(discriminator), RegistryError::WrongAccount);

    Ok(data)
}

pub(crate) fn owned_data_mut<'a>(view: &'a mut AccountView, discriminator: &[u8]) -> Result<RefMut<'a, [u8]>> {
    require!(view.owned_by(&crate::ID), RegistryError::WrongAccount);

    let data = view.try_borrow_mut()?;
    require!(data.get(..discriminator.len()) == Some(discriminator), RegistryError::WrongAccount);

    Ok(data)
}

/// Moves every lamport of a registry account to `recipient`, then closes it.
pub(crate) fn close(view: &mut AccountView, recipient: &mut AccountView) -> Result<()> {
    require!(view.address() != recipient.address(), RegistryError::WrongAccount);

    let lamports = recipient.lamports().checked_add(view.lamports()).ok_or(ProgramError::ArithmeticOverflow)?;
    recipient.set_lamports(lamports);
    view.set_lamports(0);

    view.close()
}

pub fn compare_versions(a: &SemverV1, b: &SemverV1) -> core::cmp::Ordering {
    a.major.get().cmp(&b.major.get()).then(a.minor.get().cmp(&b.minor.get())).then(a.patch.get().cmp(&b.patch.get()))
}

pub fn spec_address(address: &Address) -> sdp_intents_spec::Address {
    sdp_intents_spec::Address(address.to_bytes())
}
