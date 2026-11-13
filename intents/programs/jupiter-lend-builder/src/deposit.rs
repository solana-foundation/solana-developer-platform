//! `deposit_with_min_amount_out`: Jupiter mints the shares and fails the deposit when they are
//! fewer than the caller's floor.

use alloc::vec::Vec;

use pinocchio::error::ProgramError;
use sdp_intents_builder::programs::{ASSOCIATED_TOKEN, SYSTEM, TOKEN};
use sdp_intents_builder::token::token_account_amount;
use sdp_intents_builder::{Build, Meta};

use crate::refusals::{Refusal, INSUFFICIENT_BALANCE, MIN_SHARES_NOT_MET, ZERO_AMOUNT};
use crate::{BuildDepositV1, LENDING_PROGRAM, LIQUIDITY_PROGRAM};

const DEPOSIT_WITH_MIN_AMOUNT_OUT: [u8; 8] = [116, 144, 16, 97, 118, 109, 40, 119];

/// The arguments of `build_deposit_v1`.
pub struct Deposit {
    pub amount: u64,
    pub min_shares: u64,
}

pub(crate) fn build(accounts: &BuildDepositV1, mut build: Build<'_>, deposit: &Deposit) -> Result<(), ProgramError> {
    if let Some(refusal) = refusal(accounts, deposit)? {
        return Ok(build.refuse(refusal.code, refusal.message)?);
    }

    let share_mint = accounts.market.share_mint.address();

    if token_account_amount(&accounts.owner_share_account)?.is_none() {
        let share_account = accounts.owner_share_account.address();
        build.create_associated_token_account_idempotent_at(
            share_account,
            accounts.owner.address(),
            share_mint,
            &TOKEN,
        )?;
    }

    build.instruction(&LENDING_PROGRAM, &metas(accounts), &data(deposit))?;
    build.output(share_mint.as_ref());

    Ok(build.finish()?)
}

fn refusal(accounts: &BuildDepositV1, deposit: &Deposit) -> Result<Option<Refusal>, ProgramError> {
    if deposit.amount == 0 {
        return Ok(Some(ZERO_AMOUNT));
    }

    if let Some(refusal) = accounts.market.refusal() {
        return Ok(Some(refusal));
    }

    if token_account_amount(&accounts.owner_asset_account)?.unwrap_or(0) < deposit.amount {
        return Ok(Some(INSUFFICIENT_BALANCE));
    }

    let shares = accounts.market.shares_at_last_price(deposit.amount);

    Ok(shares.is_some_and(|shares| shares < deposit.min_shares).then_some(MIN_SHARES_NOT_MET))
}

/// The accounts of `deposit_with_min_amount_out`, in the order of its IDL.
fn metas(accounts: &BuildDepositV1) -> [Meta; 17] {
    let market = &accounts.market;

    [
        Meta::writable_signer(accounts.owner.address()),
        Meta::writable(accounts.owner_asset_account.address()),
        Meta::writable(accounts.owner_share_account.address()),
        Meta::readonly(market.asset.address()),
        Meta::readonly(market.lending_admin.address()),
        Meta::writable(market.vault.address()),
        Meta::writable(market.share_mint.address()),
        Meta::writable(market.token_reserve.address()),
        Meta::writable(market.supply_position.address()),
        Meta::readonly(market.rate_model.address()),
        Meta::writable(market.liquidity_vault.address()),
        Meta::writable(market.liquidity.address()),
        Meta::readonly(&LIQUIDITY_PROGRAM),
        Meta::readonly(market.rewards_rate_model.address()),
        Meta::readonly(&TOKEN),
        Meta::readonly(&ASSOCIATED_TOKEN),
        Meta::readonly(&SYSTEM),
    ]
}

fn data(deposit: &Deposit) -> Vec<u8> {
    [&DEPOSIT_WITH_MIN_AMOUNT_OUT[..], &deposit.amount.to_le_bytes(), &deposit.min_shares.to_le_bytes()].concat()
}
