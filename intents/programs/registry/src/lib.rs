//! The registry of SDP intents: organizations, interfaces, implementations, their versions and
//! approvals, and `verify_intent`. `packages/sdp-intents/DESIGN.md`, sections 4.6 and 4.10, gives
//! the design.
//!
//! An update authority or an approve authority of `Address::default()` means the organization
//! authority, so an index follows a change of the organization authority. Each instruction that
//! checks such an authority takes the organization that resolves it.

use anchor_lang::prelude::*;

mod error;
mod instructions;
mod limits;
pub mod state;
mod verify;

extern crate alloc;

pub use error::RegistryError;
use instructions::*;
pub use verify::SegmentLayout;
use verify::*;

declare_id!("9sgttDZ2vnzb85HWuQbx8vy6Boga32zpP5QRZ7UtbWpp");

/// The genesis hash of the cluster that this deployment serves, by the build's feature.
#[cfg(feature = "devnet")]
pub const CLUSTER: sdp_intents_spec::Address = sdp_intents_spec::cluster::DEVNET;
#[cfg(feature = "testnet")]
pub const CLUSTER: sdp_intents_spec::Address = sdp_intents_spec::cluster::TESTNET;
#[cfg(not(any(feature = "devnet", feature = "testnet")))]
pub const CLUSTER: sdp_intents_spec::Address = sdp_intents_spec::cluster::MAINNET;

#[program]
pub mod registry {
    use super::*;

    pub fn initialize_config(ctx: &mut Context<InitializeConfig>, admin: Address) -> Result<()> {
        ctx.accounts.initialize(admin)
    }

    pub fn set_registry_admin(ctx: &mut Context<ChangeConfig>, new_admin: Address) -> Result<()> {
        ctx.accounts.set_admin(new_admin)
    }

    pub fn set_organizations_gated(ctx: &mut Context<ChangeConfig>, gated: bool) -> Result<()> {
        ctx.accounts.set_organizations_gated(gated)
    }

    pub fn create_organization(
        ctx: &mut Context<CreateOrganization>,
        name_hash: [u8; 32],
        name: &[u8],
        authority: Address,
    ) -> Result<()> {
        ctx.accounts.create(name_hash, name, authority)
    }

    pub fn set_organization_authority(
        ctx: &mut Context<SetOrganizationAuthority>,
        new_authority: Address,
    ) -> Result<()> {
        ctx.accounts.set(new_authority)
    }

    pub fn create_interface(
        ctx: &mut Context<CreateInterface>,
        name_hash: [u8; 32],
        update_authority: Address,
        approve_authority: Address,
    ) -> Result<()> {
        ctx.accounts.create(name_hash, update_authority, approve_authority)
    }

    pub fn create_implementation(
        ctx: &mut Context<CreateImplementation>,
        name_hash: [u8; 32],
        update_authority: Address,
    ) -> Result<()> {
        ctx.accounts.create(name_hash, update_authority)
    }

    pub fn set_update_authority(ctx: &mut Context<ChangeIndex>, new_authority: Address) -> Result<()> {
        ctx.accounts.set_update_authority(new_authority)
    }

    pub fn set_approve_authority(ctx: &mut Context<ChangeIndex>, new_authority: Address) -> Result<()> {
        ctx.accounts.set_approve_authority(new_authority)
    }

    pub fn set_approval_policy(ctx: &mut Context<ChangeIndex>, approve_new_versions: bool) -> Result<()> {
        ctx.accounts.set_approval_policy(approve_new_versions)
    }

    pub fn write_buffer(
        ctx: &mut Context<WriteBuffer>,
        buffer_id: u32,
        document_len: u16,
        offset: u16,
        bytes: &[u8],
    ) -> Result<()> {
        let bump = ctx.bumps.buffer;

        ctx.accounts.write(buffer_id, BufferPart { document_len, offset, bytes }, bump)
    }

    pub fn close_buffer(ctx: &mut Context<CloseBuffer>) -> Result<()> {
        ctx.accounts.close()
    }

    pub fn publish(ctx: &mut Context<Publish>, document_hash: [u8; 32]) -> Result<()> {
        ctx.accounts.publish(document_hash)
    }

    pub fn set_head(ctx: &mut Context<ChangeIndex>, major: u16, minor: u16, patch: u16) -> Result<()> {
        ctx.accounts.set_head(major, minor, patch)
    }

    pub fn remove(ctx: &mut Context<Remove>, major: u16, minor: u16, patch: u16) -> Result<()> {
        ctx.accounts.remove(major, minor, patch)
    }

    pub fn approve_implementation(ctx: &mut Context<ApproveImplementation>) -> Result<()> {
        ctx.accounts.approve()
    }

    pub fn unapprove_implementation(ctx: &mut Context<UnapproveImplementation>) -> Result<()> {
        ctx.accounts.unapprove()
    }

    pub fn approve_version(ctx: &mut Context<SetVersionApproval>, major: u16, minor: u16, patch: u16) -> Result<()> {
        ctx.accounts.set(true, major, minor, patch)
    }

    pub fn unapprove_version(ctx: &mut Context<SetVersionApproval>, major: u16, minor: u16, patch: u16) -> Result<()> {
        ctx.accounts.set(false, major, minor, patch)
    }

    pub fn verify_intent(
        ctx: &mut Context<VerifyIntent>,
        intent: &[u8],
        builder_roles: &[u8],
        outputs: &[u8],
        bumps: &[u8],
        builder_bumps: &[u8],
        layout: SegmentLayout,
    ) -> Result<()> {
        let passed = ctx.remaining_accounts();
        let args = verify::VerifyArgs { intent, builder_roles, outputs, bumps, builder_bumps, layout };

        verify::verify_intent(&ctx.accounts, &passed, args)
    }
}
