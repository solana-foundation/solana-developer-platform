//! `build_withdraw_v1`: the owner's asset account when it does not exist, then one kvault `withdraw`
//! for each leg that `legs::plan` finds in the live reserve liquidity.
//!
//! The kvault `withdraw` has no minimum amount. The interface's `inflow` postcondition holds the
//! minimum, and the builder refuses a withdrawal that the estimate already puts below it.

use alloc::vec::Vec;

use kvault_interface::instructions::withdraw::{withdraw, WithdrawAccounts};
use kvault_interface::state::VaultState;
use kvault_interface::{KLEND_PROGRAM_ID, SYSVAR_INSTRUCTIONS_ID, TOKEN_PROGRAM_ID};
use pinocchio::account::AccountView;
use pinocchio::error::ProgramError;
use sdp_intents_builder::token::token_account_amount;
use sdp_intents_builder::Build;
use solana_instruction_2::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use crate::kamino::{self, address, pubkey};
use crate::legs::{self, Leg, Withdrawable};
use crate::outcome::{Outcome, Refusal};
use crate::reserve;
use crate::vault::{self, Holdings, VaultAccounts};

/// The kvault global config, the program address of `["global_config"]`.
const GLOBAL_CONFIG: Pubkey = Pubkey::from_str_const("BKyTcUe6daNG8HbgBix2ugdRHbykG2dK9hPBBqhUyoEX");

pub(crate) fn build(
    build: &mut Build<'_>,
    accounts: &VaultAccounts<'_>,
    shares: u64,
    min_amount: u64,
) -> Result<Outcome, ProgramError> {
    let state = vault::state(accounts.vault)?;

    if let Some(refusal) = precondition(&state, accounts, shares)? {
        return Ok(Outcome::Refused(refusal));
    }

    let Some(reserves) = build.require_accounts(&vault::reserve_addresses(&state))? else {
        return Ok(Outcome::NeedsAccounts);
    };

    let holdings = Holdings::read(&state, reserves)?;
    let withdrawable = withdrawable(&state, reserves)?;

    if let Some(refusal) = liquidity(&holdings, &withdrawable, shares, min_amount)? {
        return Ok(Outcome::Refused(refusal));
    }

    let legs = legs::plan(&holdings, &withdrawable, shares)?;
    let leg_accounts = LegAccounts { state: &state, accounts, reserves, refresh: vault::refresh_accounts(reserves)? };

    build.create_associated_token_account_if_missing(
        accounts.owner_asset_account,
        accounts.owner,
        &address(&state.token_mint),
        &address(&state.token_program),
    )?;

    for leg in &legs {
        kamino::push(build, &leg_accounts.instruction(leg)?)?;
    }

    build.output(state.shares_mint.as_ref());

    Ok(Outcome::Built)
}

fn precondition(
    state: &VaultState,
    accounts: &VaultAccounts<'_>,
    shares: u64,
) -> Result<Option<Refusal>, ProgramError> {
    let balance = token_account_amount(accounts.owner_share_account)?.unwrap_or(0);
    let checks = [
        (address(&state.token_mint) != *accounts.asset, Refusal::AssetMismatch),
        (shares == 0, Refusal::ZeroShares),
        (balance < shares, Refusal::InsufficientShares),
        (vault::allocations(state).next().is_none(), Refusal::NoReserves),
    ];

    Ok(checks.into_iter().find_map(|(fails, refusal)| fails.then_some(refusal)))
}

fn withdrawable(state: &VaultState, reserves: &[AccountView]) -> Result<Vec<Withdrawable>, ProgramError> {
    vault::allocations(state)
        .zip(reserves)
        .enumerate()
        .map(|(position, (allocation, view))| {
            let tokens = reserve::withdrawable(allocation, &*reserve::state(view)?);

            Ok(Withdrawable { position, tokens: tokens.ok_or(ProgramError::ArithmeticOverflow)? })
        })
        .collect()
}

/// The tokens are an estimate before the withdrawal penalty, so a refusal below `min_amount` holds.
fn liquidity(
    holdings: &Holdings,
    withdrawable: &[Withdrawable],
    shares: u64,
    min_amount: u64,
) -> Result<Option<Refusal>, ProgramError> {
    let tokens = holdings.tokens_for(shares);
    let reachable = withdrawable
        .iter()
        .try_fold(u128::from(holdings.token_available), |sum, reserve| sum.checked_add(reserve.tokens));
    let (Some(tokens), Some(reachable)) = (tokens, reachable) else {
        return Err(ProgramError::ArithmeticOverflow);
    };
    let checks = [
        (tokens > reachable, Refusal::InsufficientLiquidity),
        (tokens < u128::from(min_amount), Refusal::AmountBelowMinimum),
    ];

    Ok(checks.into_iter().find_map(|(fails, refusal)| fails.then_some(refusal)))
}

/// What every leg of one withdrawal shares.
struct LegAccounts<'a> {
    state: &'a VaultState,
    accounts: &'a VaultAccounts<'a>,
    reserves: &'a [AccountView],
    refresh: Vec<AccountMeta>,
}

impl LegAccounts<'_> {
    fn instruction(&self, leg: &Leg) -> Result<Instruction, ProgramError> {
        let allocation = vault::allocations(self.state).nth(leg.position).ok_or(ProgramError::InvalidArgument)?;
        let view = self.reserves.get(leg.position).ok_or(ProgramError::InvalidArgument)?;
        let reserve = reserve::state(view)?;
        let vault = pubkey(self.accounts.vault.address());
        let withdraw_accounts = WithdrawAccounts {
            user: pubkey(self.accounts.owner),
            vault_state: vault,
            global_config: GLOBAL_CONFIG,
            token_vault: self.state.token_vault,
            base_vault_authority: self.state.base_vault_authority,
            user_token_ata: pubkey(self.accounts.owner_asset_account.address()),
            token_mint: self.state.token_mint,
            user_shares_ata: pubkey(self.accounts.owner_share_account.address()),
            shares_mint: self.state.shares_mint,
            token_program: self.state.token_program,
            shares_token_program: TOKEN_PROGRAM_ID,
            klend_program: KLEND_PROGRAM_ID,
            invested_vault_state: vault,
            reserve: allocation.reserve,
            ctoken_vault: allocation.ctoken_vault,
            lending_market: reserve.lending_market,
            lending_market_authority: reserve::lending_market_authority(&reserve.lending_market),
            reserve_liquidity_supply: reserve.liquidity.supply_vault,
            reserve_collateral_mint: reserve.collateral.mint_pubkey,
            reserve_collateral_token_program: TOKEN_PROGRAM_ID,
            instruction_sysvar_account: SYSVAR_INSTRUCTIONS_ID,
        };

        Ok(withdraw(withdraw_accounts, leg.shares, self.refresh.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_global_config_is_its_program_address() {
        let (derived, _) = kvault_interface::pda::global_config(&kvault_interface::KVAULT_PROGRAM_ID);

        assert_eq!(derived, GLOBAL_CONFIG);
    }
}
