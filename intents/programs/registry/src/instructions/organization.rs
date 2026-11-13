use anchor_lang::prelude::*;

use crate::error::RegistryError;
use crate::state::config::RegistryConfigV1;
use crate::state::organization::{check_name, OrganizationV1};
use crate::state::{CONFIG_SEED, ORGANIZATION_SEED};

/// While the config gates organizations, only its admin creates one, and names the authority of
/// whoever asked for it. Otherwise the name is first come. Either way the creator names the
/// authority, which need not sign.
#[derive(Accounts)]
// Anchor's exit hook binds the argument and does not read it. The underscore keeps that from a
// warning.
#[instruction(_name_hash: [u8; 32])]
pub struct CreateOrganization {
    #[account(mut)]
    pub payer: Signer,
    pub creator: Signer,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<RegistryConfigV1>,
    #[account(init, payer = payer, seeds = [ORGANIZATION_SEED, _name_hash.as_ref()], bump)]
    pub organization: Account<OrganizationV1>,
    pub system_program: Program<System>,
}

impl CreateOrganization {
    pub fn create(&mut self, name_hash: [u8; 32], name: &[u8], authority: Address) -> Result<()> {
        require!(
            !self.config.organizations_gated.get() || *self.creator.address() == self.config.admin,
            RegistryError::OrganizationsGated
        );

        check_name(name)?;
        require!(anchor_lang::sha256(name) == name_hash, RegistryError::WrongNameHash);

        let organization = &mut *self.organization;
        organization.authority = authority;
        organization.name_hash = name_hash;
        organization.name_len = u8::try_from(name.len()).map_err(|_| RegistryError::BadName)?;
        organization.name.get_mut(..name.len()).ok_or(RegistryError::BadName)?.copy_from_slice(name);

        Ok(())
    }
}

#[derive(Accounts)]
pub struct SetOrganizationAuthority {
    #[account(mut)]
    pub organization: Account<OrganizationV1>,
    #[account(address = organization.authority @ RegistryError::WrongAuthority)]
    pub authority: Signer,
}

impl SetOrganizationAuthority {
    pub fn set(&mut self, new_authority: Address) -> Result<()> {
        self.organization.authority = new_authority;

        Ok(())
    }
}
