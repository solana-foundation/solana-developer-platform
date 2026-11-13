use anchor_lang::prelude::*;
use sdp_intents_spec::wire::{DocumentKind, PodBool};

use crate::error::RegistryError;
use crate::state::index::{self, Index, VersionIndexV1};
use crate::state::organization::OrganizationV1;
use crate::state::{semver, INDEX_SEED};

pub const INTERFACE_KIND_SEED: &[u8] = &[DocumentKind::Interface as u8];
pub const IMPLEMENTATION_KIND_SEED: &[u8] = &[DocumentKind::Implementation as u8];

#[derive(Accounts)]
// Anchor's exit hook binds the argument and does not read it. The underscore keeps that from a
// warning.
#[instruction(_name_hash: [u8; 32])]
pub struct CreateInterface {
    #[account(mut)]
    pub payer: Signer,
    pub organization: Account<OrganizationV1>,
    #[account(address = organization.authority @ RegistryError::WrongAuthority)]
    pub authority: Signer,
    #[account(
        init,
        payer = payer,
        seeds = [INDEX_SEED, INTERFACE_KIND_SEED, organization.address().as_ref(), _name_hash.as_ref()],
        bump
    )]
    pub index: Account<VersionIndexV1>,
    pub system_program: Program<System>,
}

impl CreateInterface {
    pub fn create(&mut self, name_hash: [u8; 32], update_authority: Address, approve_authority: Address) -> Result<()> {
        let index = &mut *self.index;
        index.kind = DocumentKind::Interface.into();
        index.organization = *self.organization.address();
        index.name_hash = name_hash;
        index.update_authority = update_authority;
        index.approve_authority = approve_authority;

        Ok(())
    }
}

/// Anyone can propose an implementation of any interface. The interface's approve authority
/// decides whether UIs show it.
#[derive(Accounts)]
// Anchor's exit hook binds the argument and does not read it. The underscore keeps that from a
// warning.
#[instruction(_name_hash: [u8; 32])]
pub struct CreateImplementation {
    #[account(mut)]
    pub payer: Signer,
    pub organization: Account<OrganizationV1>,
    #[account(address = organization.authority @ RegistryError::WrongAuthority)]
    pub authority: Signer,
    pub interface_index: UncheckedAccount,
    #[account(
        init,
        payer = payer,
        seeds = [INDEX_SEED, IMPLEMENTATION_KIND_SEED, organization.address().as_ref(), _name_hash.as_ref()],
        bump
    )]
    pub index: Account<VersionIndexV1>,
    pub system_program: Program<System>,
}

impl CreateImplementation {
    pub fn create(&mut self, name_hash: [u8; 32], update_authority: Address) -> Result<()> {
        Index::parse(&index::load(self.interface_index.account())?)?.require_kind(DocumentKind::Interface)?;

        let index = &mut *self.index;
        index.kind = DocumentKind::Implementation.into();
        index.organization = *self.organization.address();
        index.name_hash = name_hash;
        index.update_authority = update_authority;
        index.interface = *self.interface_index.address();

        Ok(())
    }
}

/// A change to the fixed part of one index, by its update authority or its approve authority.
/// `organization` is the index's own, which resolves an authority of `Address::default()`.
#[derive(Accounts)]
pub struct ChangeIndex {
    pub authority: Signer,
    pub organization: Account<OrganizationV1>,
    #[account(mut)]
    pub index: UncheckedAccount,
}

impl ChangeIndex {
    pub fn set_update_authority(&mut self, new_authority: Address) -> Result<()> {
        let mut view = *self.index.account();
        let mut header = index::header_mut(&mut view)?;
        self.require_organization(&header)?;
        self.organization.require_authority(&header.update_authority, &self.authority)?;

        header.update_authority = new_authority;

        Ok(())
    }

    pub fn set_approve_authority(&mut self, new_authority: Address) -> Result<()> {
        let mut view = *self.index.account();
        let mut header = index::header_mut(&mut view)?;
        self.require_approve_authority(&header)?;

        header.approve_authority = new_authority;

        Ok(())
    }

    /// The policy applies to versions that `publish` adds later. It does not change a version
    /// that is published already.
    pub fn set_approval_policy(&mut self, approve_new_versions: bool) -> Result<()> {
        let mut view = *self.index.account();
        let mut header = index::header_mut(&mut view)?;
        self.require_approve_authority(&header)?;

        header.approve_new_versions = PodBool::new(approve_new_versions);

        Ok(())
    }

    pub fn set_head(&mut self, major: u16, minor: u16, patch: u16) -> Result<()> {
        let version = semver(major, minor, patch);
        let mut view = *self.index.account();

        Index::parse(&index::load(&view)?)?.entry(&version).ok_or(RegistryError::VersionNotPublished)?;

        let mut header = index::header_mut(&mut view)?;
        self.require_organization(&header)?;
        self.organization.require_authority(&header.update_authority, &self.authority)?;

        header.has_head = PodBool::new(true);
        header.head = version;

        Ok(())
    }

    fn require_organization(&self, header: &VersionIndexV1) -> Result<()> {
        require!(header.organization == *self.organization.address(), RegistryError::WrongAccount);

        Ok(())
    }

    fn require_approve_authority(&self, header: &VersionIndexV1) -> Result<()> {
        self.require_organization(header)?;
        require!(header.kind == u8::from(DocumentKind::Interface), RegistryError::WrongIndexKind);

        self.organization.require_authority(&header.approve_authority, &self.authority)
    }
}
