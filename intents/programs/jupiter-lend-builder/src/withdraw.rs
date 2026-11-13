//! `redeem_with_min_amount_out`: Jupiter burns the shares and fails the withdrawal when it pays
//! less of the asset than the caller's floor.

use alloc::vec::Vec;

use pinocchio::error::ProgramError;
use sdp_intents_builder::programs::{ASSOCIATED_TOKEN, SYSTEM, TOKEN};
use sdp_intents_builder::token::token_account_amount;
use sdp_intents_builder::{Build, Meta};

use crate::refusals::{Refusal, INSUFFICIENT_LIQUIDITY, INSUFFICIENT_SHARES, ZERO_SHARES};
use crate::{BuildWithdrawV1, LENDING_PROGRAM, LIQUIDITY_PROGRAM};

const REDEEM_WITH_MIN_AMOUNT_OUT: [u8; 8] = [235, 189, 237, 56, 166, 180, 184, 149];

/// The arguments of `build_withdraw_v1`.
pub struct Withdrawal {
    pub shares: u64,
    pub min_amount: u64,
}

pub(crate) fn build(
    accounts: &BuildWithdrawV1,
    mut build: Build<'_>,
    withdrawal: &Withdrawal,
) -> Result<(), ProgramError> {
    if let Some(refusal) = refusal(accounts, withdrawal)? {
        return Ok(build.refuse(refusal.code, refusal.message)?);
    }

    let asset = accounts.market.asset.address();

    if token_account_amount(&accounts.owner_asset_account)?.is_none() {
        let asset_account = accounts.owner_asset_account.address();
        build.create_associated_token_account_idempotent_at(asset_account, accounts.owner.address(), asset, &TOKEN)?;
    }

    build.instruction(&LENDING_PROGRAM, &metas(accounts), &data(withdrawal))?;
    build.output(accounts.market.share_mint.address().as_ref());

    Ok(build.finish()?)
}

fn refusal(accounts: &BuildWithdrawV1, withdrawal: &Withdrawal) -> Result<Option<Refusal>, ProgramError> {
    if withdrawal.shares == 0 {
        return Ok(Some(ZERO_SHARES));
    }

    if let Some(refusal) = accounts.market.refusal() {
        return Ok(Some(refusal));
    }

    if token_account_amount(&accounts.owner_share_account)?.unwrap_or(0) < withdrawal.shares {
        return Ok(Some(INSUFFICIENT_SHARES));
    }

    let liquidity = token_account_amount(&accounts.market.liquidity_vault)?.unwrap_or(0);

    Ok((liquidity < withdrawal.min_amount).then_some(INSUFFICIENT_LIQUIDITY))
}

/// The accounts of `redeem_with_min_amount_out`, in the order of its IDL.
fn metas(accounts: &BuildWithdrawV1) -> [Meta; 18] {
    let market = &accounts.market;

    [
        Meta::writable_signer(accounts.owner.address()),
        Meta::writable(accounts.owner_share_account.address()),
        Meta::writable(accounts.owner_asset_account.address()),
        Meta::readonly(market.lending_admin.address()),
        Meta::writable(market.vault.address()),
        Meta::readonly(market.asset.address()),
        Meta::writable(market.share_mint.address()),
        Meta::writable(market.token_reserve.address()),
        Meta::writable(market.supply_position.address()),
        Meta::readonly(market.rate_model.address()),
        Meta::writable(market.liquidity_vault.address()),
        Meta::writable(accounts.claim_account.address()),
        Meta::writable(market.liquidity.address()),
        Meta::readonly(&LIQUIDITY_PROGRAM),
        Meta::readonly(market.rewards_rate_model.address()),
        Meta::readonly(&TOKEN),
        Meta::readonly(&ASSOCIATED_TOKEN),
        Meta::readonly(&SYSTEM),
    ]
}

fn data(withdrawal: &Withdrawal) -> Vec<u8> {
    [&REDEEM_WITH_MIN_AMOUNT_OUT[..], &withdrawal.shares.to_le_bytes(), &withdrawal.min_amount.to_le_bytes()].concat()
}
