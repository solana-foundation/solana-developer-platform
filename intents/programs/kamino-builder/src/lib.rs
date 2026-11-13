//! Builds Kamino vault (kvault) deposits and withdrawals for the `vault.deposit` and `vault.withdraw`
//! interfaces, with the layouts and the instruction account lists of `kvault-interface` and
//! `klend-interface`.
//!
//! - The record names the vault, the owner, the asset, and the owner's two token accounts. Round 1
//!   reads the vault in place and asks for its reserves with `MoreAccounts`, because the vault holds
//!   a list of up to 25 allocations that the static language cannot read.
//! - Round 2 reads the reserves. Each kvault instruction names every reserve and its lending market,
//!   and the kvault program refreshes them by CPI, so the builder adds no refresh instruction.
//! - A withdrawal draws on the vault's available tokens first, then on the reserves with the most
//!   liquidity that the vault can withdraw, with one kvault `withdraw` for each reserve.
//! - The builder creates an owner's token account only when it does not exist.

#![no_std]

extern crate alloc;

use anchor_lang::prelude::*;
use sdp_intents_builder::Build;

mod deposit;
mod kamino;
mod legs;
mod outcome;
mod reserve;
mod vault;
mod withdraw;

pub use outcome::Refusal;

declare_id!("LNuhpDaM2bKkoaGPMDJ4aALq8CGKNz2Xq336bo6Tafy");

#[program]
pub mod kamino_builder {
    use super::*;

    pub fn build_deposit_v1(ctx: &mut Context<BuildVaultV1>, amount: u64, min_shares: u64, bumps: &[u8]) -> Result<()> {
        let remaining = ctx.remaining_accounts();
        let mut build = Build::new(ctx.program_id, <BuildVaultV1 as TryAccounts>::HEADER_SIZE, &remaining, bumps)?;
        let outcome = deposit::build(&mut build, &ctx.accounts.views(), amount, min_shares)?;

        Ok(outcome.finish(build)?)
    }

    pub fn build_withdraw_v1(
        ctx: &mut Context<BuildVaultV1>,
        shares: u64,
        min_amount: u64,
        bumps: &[u8],
    ) -> Result<()> {
        let remaining = ctx.remaining_accounts();
        let mut build = Build::new(ctx.program_id, <BuildVaultV1 as TryAccounts>::HEADER_SIZE, &remaining, bumps)?;
        let outcome = withdraw::build(&mut build, &ctx.accounts.views(), shares, min_amount)?;

        Ok(outcome.finish(build)?)
    }
}

/// The accounts of both records, in their order. The records name `token_program` and `share_mint`
/// to derive the owner's token accounts. The builder reads both from the vault.
#[derive(Accounts)]
pub struct BuildVaultV1 {
    pub vault: UncheckedAccount,
    pub owner: UncheckedAccount,
    pub asset: UncheckedAccount,
    pub token_program: UncheckedAccount,
    pub share_mint: UncheckedAccount,
    pub owner_asset_account: UncheckedAccount,
    pub owner_share_account: UncheckedAccount,
}

impl BuildVaultV1 {
    fn views(&self) -> vault::VaultAccounts<'_> {
        vault::VaultAccounts {
            vault: self.vault.account(),
            owner: self.owner.address(),
            asset: self.asset.address(),
            owner_asset_account: self.owner_asset_account.account(),
            owner_share_account: self.owner_share_account.account(),
        }
    }
}
