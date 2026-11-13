use anchor_lang::prelude::*;

use crate::error::RegistryError;
use crate::state::config::RegistryConfigV1;
use crate::state::wire::PodBool;
use crate::state::CONFIG_SEED;

/// `BPFLoaderUpgradeab1e11111111111111111111111`, which owns each upgradeable program's data.
const UPGRADEABLE_LOADER: Address = Address::new_from_array([
    2, 168, 246, 145, 78, 136, 161, 176, 226, 16, 21, 62, 247, 99, 174, 43, 0, 194, 185, 61, 22, 193, 36, 210, 192, 83,
    122, 16, 4, 128, 0, 0,
]);
/// The loader's `ProgramData` state: a `u32` tag of 3, the deploy slot, then an optional upgrade
/// authority as a tag byte and 32 bytes.
const PROGRAM_DATA_TAG: [u8; 4] = 3u32.to_le_bytes();
const AUTHORITY_TAG_OFFSET: usize = 12;
const AUTHORITY_OFFSET: usize = 13;

/// Only the program's upgrade authority creates the config, so no one can take it between the
/// deploy and its first use. Organizations start gated.
#[derive(Accounts)]
pub struct InitializeConfig {
    #[account(mut)]
    pub payer: Signer,
    pub upgrade_authority: Signer,
    pub program_data: UncheckedAccount,
    #[account(init, payer = payer, seeds = [CONFIG_SEED], bump)]
    pub config: Account<RegistryConfigV1>,
    pub system_program: Program<System>,
}

impl InitializeConfig {
    pub fn initialize(&mut self, admin: Address) -> Result<()> {
        require!(
            upgrade_authority(self.program_data.account())? == *self.upgrade_authority.address(),
            RegistryError::NotUpgradeAuthority
        );

        self.config.admin = admin;
        self.config.organizations_gated = PodBool::from(true);

        Ok(())
    }
}

/// The upgrade authority in the registry's program data. A program with no upgrade authority
/// has none, so its config cannot be created.
fn upgrade_authority(view: &AccountView) -> Result<Address> {
    let (expected, _bump) = anchor_lang::find_program_address(&[crate::ID.as_ref()], &UPGRADEABLE_LOADER);
    require!(*view.address() == expected && view.owned_by(&UPGRADEABLE_LOADER), RegistryError::NotUpgradeAuthority);

    let data = view.try_borrow()?;
    let authority_end = AUTHORITY_OFFSET.checked_add(32).ok_or(ProgramError::ArithmeticOverflow)?;
    require!(
        data.get(..4) == Some(PROGRAM_DATA_TAG.as_slice()) && data.get(AUTHORITY_TAG_OFFSET) == Some(&1),
        RegistryError::NotUpgradeAuthority
    );

    let authority: [u8; 32] = data
        .get(AUTHORITY_OFFSET..authority_end)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(RegistryError::NotUpgradeAuthority)?;

    Ok(Address::new_from_array(authority))
}

#[derive(Accounts)]
pub struct ChangeConfig {
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<RegistryConfigV1>,
    #[account(address = config.admin @ RegistryError::WrongAuthority)]
    pub admin: Signer,
}

impl ChangeConfig {
    pub fn set_admin(&mut self, new_admin: Address) -> Result<()> {
        self.config.admin = new_admin;

        Ok(())
    }

    pub fn set_organizations_gated(&mut self, gated: bool) -> Result<()> {
        self.config.organizations_gated = PodBool::from(gated);

        Ok(())
    }
}
