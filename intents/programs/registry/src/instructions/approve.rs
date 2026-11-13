//! The approvals of an interface's approve authority. A version of an implementation is approved
//! when the interface's list holds the implementation and the version's entry is approved.

use anchor_lang::prelude::*;
use sdp_intents_spec::wire::DocumentKind;

use crate::error::RegistryError;
use crate::state::index::{self, Index};
use crate::state::organization::OrganizationV1;
use crate::state::semver;

/// `organization` is the interface's, which resolves an approve authority of `Address::default()`.
#[derive(Accounts)]
pub struct ApproveImplementation {
    #[account(mut)]
    pub payer: Signer,
    pub authority: Signer,
    pub organization: Account<OrganizationV1>,
    #[account(mut)]
    pub interface_index: UncheckedAccount,
    pub implementation_index: UncheckedAccount,
    pub system_program: Program<System>,
}

impl ApproveImplementation {
    pub fn approve(&mut self) -> Result<()> {
        require_approve_authority(&self.organization, self.interface_index.account(), &self.authority)?;
        require_implementation_of(self.implementation_index.account(), self.interface_index.address())?;

        let mut interface_view = *self.interface_index.account();

        index::push_approved(&mut interface_view, self.payer.account(), self.implementation_index.address())
    }
}

/// The rent of the removed address goes to `recipient`.
#[derive(Accounts)]
pub struct UnapproveImplementation {
    pub authority: Signer,
    pub organization: Account<OrganizationV1>,
    #[account(mut)]
    pub interface_index: UncheckedAccount,
    pub implementation_index: UncheckedAccount,
    #[account(mut)]
    pub recipient: UncheckedAccount,
}

impl UnapproveImplementation {
    pub fn unapprove(&mut self) -> Result<()> {
        require_approve_authority(&self.organization, self.interface_index.account(), &self.authority)?;

        let mut interface_view = *self.interface_index.account();

        index::remove_approved(&mut interface_view, self.recipient.account(), self.implementation_index.address())
    }
}

#[derive(Accounts)]
pub struct SetVersionApproval {
    pub authority: Signer,
    pub organization: Account<OrganizationV1>,
    pub interface_index: UncheckedAccount,
    #[account(mut)]
    pub implementation_index: UncheckedAccount,
}

impl SetVersionApproval {
    pub fn set(&mut self, approved: bool, major: u16, minor: u16, patch: u16) -> Result<()> {
        require_approve_authority(&self.organization, self.interface_index.account(), &self.authority)?;
        require_implementation_of(self.implementation_index.account(), self.interface_index.address())?;

        let mut implementation_view = *self.implementation_index.account();

        index::set_version_approved(&mut implementation_view, &semver(major, minor, patch), approved)
    }
}

fn require_approve_authority(
    organization: &Account<OrganizationV1>,
    interface_index: &AccountView,
    signer: &Signer,
) -> Result<()> {
    let data = index::load(interface_index)?;
    let interface = Index::parse(&data)?;
    interface.require_kind(DocumentKind::Interface)?;

    require!(interface.header.organization == *organization.address(), RegistryError::WrongAccount);

    organization.require_authority(&interface.header.approve_authority, signer)
}

fn require_implementation_of(implementation_index: &AccountView, interface_index: &Address) -> Result<()> {
    let data = index::load(implementation_index)?;
    let implementation = Index::parse(&data)?;
    implementation.require_kind(DocumentKind::Implementation)?;

    require!(implementation.header.interface == *interface_index, RegistryError::WrongAccount);

    Ok(())
}
