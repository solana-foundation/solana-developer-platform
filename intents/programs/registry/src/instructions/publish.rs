use anchor_lang::prelude::*;
use sdp_intents_spec::wire::{DocumentIdV1, DocumentKind};
use sdp_intents_spec::{Implementation, Interface};

use crate::error::RegistryError;
use crate::state::buffer::{self, BufferV1, MAX_DOCUMENT_LEN};
use crate::state::index::{self, Index, VersionEntryV1};
use crate::state::organization::OrganizationV1;
use crate::state::version::{self, InterfaceV1, VersionSeeds};
use crate::state::wire::{PodBool, PodU64, SemverV1};
use crate::state::{close, owned_data, spec_address, stored_version};

/// Publishes the document in `buffer` as a new version of `index`, and closes the buffer. The head
/// does not move. `interface_index` is the interface's index when `index` is an implementation's.
#[derive(Accounts)]
pub struct Publish {
    #[account(mut)]
    pub payer: Signer,
    pub authority: Signer,
    pub organization: Account<OrganizationV1>,
    #[account(mut)]
    pub index: UncheckedAccount,
    #[account(mut)]
    pub buffer: UncheckedAccount,
    /// Receives the rent of the buffer.
    #[account(mut)]
    pub buffer_writer: UncheckedAccount,
    #[account(mut)]
    pub version: UncheckedAccount,
    pub interface_index: Option<UncheckedAccount>,
    pub system_program: Program<System>,
}

/// What the index says about the document that it takes.
struct Target {
    kind: DocumentKind,
    name_hash: [u8; 32],
    interface: Address,
}

/// The version that `publish` adds, whether the interface's policy approves it, and its tier.
struct Published {
    version: SemverV1,
    approved: bool,
    tier: u8,
}

impl Publish {
    pub fn publish(&mut self, document_hash: [u8; 32]) -> Result<()> {
        let target = self.authorize()?;
        let buffer_data = owned_data(self.buffer.account(), BufferV1::DISCRIMINATOR)?;
        let document = buffer_data.get(buffer::FIXED_LEN..).ok_or(RegistryError::WrongAccount)?;

        require!(document.len() <= MAX_DOCUMENT_LEN, RegistryError::DocumentTooLarge);
        require!(anchor_lang::sha256(document) == document_hash, RegistryError::WrongDocumentHash);

        let published = self.check_document(&target, document)?;
        let existing = Index::parse(&index::load(self.index.account())?)?.entry(&published.version).copied();
        require!(!existing.is_some_and(|entry| entry.removed.get()), RegistryError::VersionRemoved);
        require!(existing.is_none(), RegistryError::AlreadyPublished);

        let publish_slot = Clock::get()?.slot;
        self.create_version(&target, &published.version, publish_slot, document)?;
        drop(buffer_data);

        let entry = VersionEntryV1 {
            version: published.version,
            publish_slot: PodU64::from(publish_slot),
            approved: PodBool::from(published.approved),
            removed: PodBool::from(false),
            tier: published.tier,
        };

        let mut index_view = *self.index.account();
        index::insert_version(&mut index_view, self.payer.account(), entry)?;

        require!(
            crate::instructions::buffer::buffer_authority(self.buffer.account())? == *self.buffer_writer.address(),
            RegistryError::WrongBuffer
        );

        let mut buffer = *self.buffer.account();
        let mut buffer_writer = *self.buffer_writer.account();

        close(&mut buffer, &mut buffer_writer)
    }

    fn authorize(&self) -> Result<Target> {
        let data = index::load(self.index.account())?;
        let index = Index::parse(&data)?;

        require!(index.header.organization == *self.organization.address(), RegistryError::WrongAccount);
        self.organization.require_authority(&index.header.update_authority, &self.authority)?;

        Ok(Target { kind: index.kind()?, name_hash: index.header.name_hash, interface: index.header.interface })
    }

    /// Validates the document with its view and the limits, and checks that its id names the index.
    fn check_document(&self, target: &Target, document: &[u8]) -> Result<Published> {
        let (id, approved, tier) = match target.kind {
            DocumentKind::Interface => {
                let interface = Interface::parse(document).map_err(|_| RegistryError::BadDocument)?;
                crate::limits::check_interface(&interface)?;

                (*interface.id(), false, 0)
            }
            DocumentKind::Implementation => {
                let implementation = Implementation::parse(document).map_err(|_| RegistryError::BadDocument)?;
                crate::limits::check_implementation(&implementation)?;
                require!(*implementation.cluster() == crate::CLUSTER, RegistryError::WrongCluster);
                let tier = implementation.recipe().map_err(|_| RegistryError::BadDocument)?.tier();
                let policy_approves = self.check_implements(target, &implementation)?;

                (*implementation.id(), policy_approves && self.keeps_tier(tier)?, tier)
            }
            DocumentKind::Intent => return Err(RegistryError::WrongIndexKind.into()),
        };

        self.check_id(target, &id)?;

        Ok(Published { version: stored_version(&id.version), approved, tier })
    }

    fn check_id(&self, target: &Target, id: &DocumentIdV1) -> Result<()> {
        require!(
            id.publisher == spec_address(self.organization.address()) && id.name_hash == target.name_hash,
            RegistryError::WrongDocumentId
        );

        Ok(())
    }

    /// The interface index must list the lowest version of the range that the implementation names.
    /// The interface's policy approves the new version when the interface approves the
    /// implementation.
    fn check_implements(&self, target: &Target, implementation: &Implementation<'_>) -> Result<bool> {
        let interface_index = self.interface_index.as_ref().ok_or(RegistryError::WrongAccount)?;
        require!(*interface_index.address() == target.interface, RegistryError::WrongAccount);

        let data = index::load(interface_index.account())?;
        let interface = Index::parse(&data)?;
        let implements = implementation.implements();
        interface.require_kind(DocumentKind::Interface)?;

        require!(
            spec_address(&interface.header.organization) == implements.publisher
                && interface.header.name_hash == implements.name_hash,
            RegistryError::WrongDocumentId
        );

        let interface_version =
            interface.entry(&stored_version(&implements.version)).ok_or(RegistryError::InterfaceVersionNotPublished)?;
        require!(!interface_version.removed.get(), RegistryError::VersionRemoved);

        Ok(interface.header.approve_new_versions.get() && interface.approves(self.index.address()))
    }

    /// The policy carries an approval to a new version only when its tier is no worse than the tier
    /// of the highest approved version. With no approved version, a new version needs its own
    /// approval.
    fn keeps_tier(&self, tier: u8) -> Result<bool> {
        let data = index::load(self.index.account())?;
        let index = Index::parse(&data)?;
        let highest_approved = index.versions.iter().rev().find(|entry| entry.approved.get() && !entry.removed.get());

        Ok(highest_approved.is_some_and(|entry| tier <= entry.tier))
    }

    fn create_version(&self, target: &Target, version: &SemverV1, publish_slot: u64, document: &[u8]) -> Result<()> {
        let seeds = VersionSeeds::new(version);
        let organization = self.organization.address();
        let address_seeds: [&[u8]; 6] = [
            version::seed(target.kind)?,
            organization.as_ref(),
            &target.name_hash,
            &seeds.major,
            &seeds.minor,
            &seeds.patch,
        ];

        let (address, bump) = anchor_lang::find_program_address(&address_seeds, &crate::ID);

        require!(address == *self.version.address(), RegistryError::WrongAccount);

        let [kind_seed, organization_seed, name_seed, major, minor, patch] = address_seeds;
        let signer_seeds: [&[u8]; 7] = [kind_seed, organization_seed, name_seed, major, minor, patch, &[bump]];
        let space = version::FIXED_LEN.checked_add(document.len()).ok_or(ProgramError::ArithmeticOverflow)?;
        anchor_lang::create_account_signed(
            self.payer.account(),
            self.version.account(),
            space,
            &crate::ID,
            &signer_seeds,
        )?;

        // Both kinds share the layout of `InterfaceV1`. The discriminator names the kind.
        let header = InterfaceV1 { version: *version, publish_slot: PodU64::from(publish_slot) };
        let discriminator = version::discriminator(target.kind)?;
        let mut view = *self.version.account();
        let mut data = view.try_borrow_mut()?;

        data.get_mut(..8).ok_or(RegistryError::WrongAccount)?.copy_from_slice(discriminator);
        data.get_mut(8..version::FIXED_LEN)
            .ok_or(RegistryError::WrongAccount)?
            .copy_from_slice(bytemuck::bytes_of(&header));
        data.get_mut(version::FIXED_LEN..).ok_or(RegistryError::WrongAccount)?.copy_from_slice(document);

        Ok(())
    }
}
