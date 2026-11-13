//! A builder for Jupiter Lend Earn, the `jupiter-lend-deposit` and `jupiter-lend-withdraw` implementations
//! of `vault.deposit` and `vault.withdraw`. It builds the instructions that `@sdp/jupiter-lend`
//! builds through `@jup-ag/lend`: `deposit_with_min_amount_out` and `redeem_with_min_amount_out` of
//! the lending program, after an ATA create when the owner has no token account to receive into.
//!
//! - The vault input is the market's `Lending` account. The implementations derive every other account
//!   from the vault and the asset, so the builder needs one round and asks for no accounts.
//! - The builder checks that the vault names the accounts that the implementation derives, and refuses a
//!   precondition that it can read. The lending program checks the rest when the transaction lands.
//! - The ATA create runs only when the account does not exist. The planner refuses an instruction
//!   that names the rent payer and creates no account.
//! - The implementations cover SPL Token assets, because an ATA seed names the token program.

#![cfg_attr(not(feature = "idl-build"), no_std)]

extern crate alloc;

mod deposit;
mod market;
pub mod refusals;
pub mod state;
mod withdraw;

use anchor_lang::prelude::*;
use sdp_intents_builder::Build;

pub use deposit::Deposit;
pub use withdraw::Withdrawal;

declare_id!("koLiHYTtLE26sbQgv5P51J3ap6m8GLUUMoKtQgLb1Hw");

/// The lending program of the Jupiter Lend main market, which owns each `Lending` account.
pub const LENDING_PROGRAM: Address = Address::from_str_const("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
/// The liquidity program, which holds the assets of every market.
pub const LIQUIDITY_PROGRAM: Address = Address::from_str_const("jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC");

#[program]
pub mod jupiter_lend_builder {
    use super::*;

    pub fn build_deposit_v1(
        ctx: &mut Context<BuildDepositV1>,
        amount: u64,
        min_shares: u64,
        bumps: &[u8],
    ) -> Result<()> {
        let remaining = ctx.remaining_accounts();
        let build = Build::new(ctx.program_id, <BuildDepositV1 as TryAccounts>::HEADER_SIZE, &remaining, bumps)?;

        deposit::build(&ctx.accounts, build, &Deposit { amount, min_shares })
    }

    pub fn build_withdraw_v1(
        ctx: &mut Context<BuildWithdrawV1>,
        shares: u64,
        min_amount: u64,
        bumps: &[u8],
    ) -> Result<()> {
        let remaining = ctx.remaining_accounts();
        let build = Build::new(ctx.program_id, <BuildWithdrawV1 as TryAccounts>::HEADER_SIZE, &remaining, bumps)?;

        withdraw::build(&ctx.accounts, build, &Withdrawal { shares, min_amount })
    }
}

/// The accounts of one earn market, in the order of the implementations.
#[derive(Accounts)]
pub struct Market {
    pub vault: UncheckedAccount,
    pub asset: UncheckedAccount,
    pub share_mint: UncheckedAccount,
    pub lending_admin: UncheckedAccount,
    pub token_reserve: UncheckedAccount,
    pub supply_position: UncheckedAccount,
    pub rate_model: UncheckedAccount,
    pub liquidity: UncheckedAccount,
    pub liquidity_vault: UncheckedAccount,
    pub rewards_rate_model: UncheckedAccount,
}

#[derive(Accounts)]
pub struct BuildDepositV1 {
    pub market: Nested<Market>,
    pub owner: UncheckedAccount,
    pub owner_asset_account: UncheckedAccount,
    pub owner_share_account: UncheckedAccount,
}

#[derive(Accounts)]
pub struct BuildWithdrawV1 {
    pub market: Nested<Market>,
    pub owner: UncheckedAccount,
    pub owner_asset_account: UncheckedAccount,
    pub owner_share_account: UncheckedAccount,
    /// The liquidity program's claim account of the lending admin for the asset.
    pub claim_account: UncheckedAccount,
}
