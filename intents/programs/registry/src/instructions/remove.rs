use anchor_lang::prelude::*;

use crate::error::RegistryError;
use crate::state::index::{self, Index};
use crate::state::organization::OrganizationV1;
use crate::state::{close, semver, spec_address, version};

/// Revokes a version: closes its account and takes its entry out of the index. Both rents go to
/// `recipient`. The head version stays until the head moves.
#[derive(Accounts)]
pub struct Remove {
    pub authority: Signer,
    pub organization: Account<OrganizationV1>,
    #[account(mut)]
    pub index: UncheckedAccount,
    #[account(mut)]
    pub version: UncheckedAccount,
    #[account(mut)]
    pub recipient: UncheckedAccount,
}

impl Remove {
    pub fn remove(&mut self, major: u16, minor: u16, patch: u16) -> Result<()> {
        let version = semver(major, minor, patch);
        let position = {
            let data = index::load(self.index.account())?;
            let index = Index::parse(&data)?;
            let header = index.header;

            require!(header.organization == *self.organization.address(), RegistryError::WrongAccount);
            self.organization.require_authority(&header.update_authority, &self.authority)?;
            require!(!(header.has_head.get() && header.head == version), RegistryError::RemovesHead);

            let kind = index.kind()?;
            let version_data = version::load(self.version.account(), kind)?;
            let id = version::document_id(kind, version::document(&version_data)?)?;

            require!(
                id.publisher == spec_address(&header.organization)
                    && id.name_hash == header.name_hash
                    && id.version == version,
                RegistryError::WrongDocumentId
            );

            index.find(&version).map_err(|_| RegistryError::VersionNotPublished)?
        };

        let mut index_view = *self.index.account();
        let mut version_view = *self.version.account();
        let mut recipient = *self.recipient.account();
        index::remove_version(&mut index_view, &recipient, position)?;

        close(&mut version_view, &mut recipient)
    }
}
