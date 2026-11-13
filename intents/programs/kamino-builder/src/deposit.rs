//! `build_deposit_v1`: one kvault deposit, after the owner's share account when it does not exist.
//!
//! A deposit with `min_shares` above zero is a kvault `deposit_with_min_shares_out`, as in the klend
//! SDK, so the kvault program refuses to mint fewer shares. `kvault-interface` 0.1.0 does not build
//! that instruction. It takes the accounts of `deposit`, and the tests run it on the mainnet program.

use kvault_interface::discriminators::sha256_first8;
use kvault_interface::instructions::deposit::{deposit, DepositAccounts};
use kvault_interface::state::VaultState;
use kvault_interface::{KLEND_PROGRAM_ID, TOKEN_PROGRAM_ID};
use pinocchio::account::AccountView;
use pinocchio::error::ProgramError;
use sdp_intents_builder::programs::TOKEN;
use sdp_intents_builder::token::token_account_amount;
use sdp_intents_builder::Build;
use solana_instruction_2::Instruction;

use crate::kamino::{self, address, pubkey};
use crate::outcome::{Outcome, Refusal};
use crate::vault::{self, Holdings, VaultAccounts};

const DEPOSIT_WITH_MIN_SHARES_OUT: [u8; 8] = sha256_first8(b"global:deposit_with_min_shares_out");

pub(crate) fn build(
    build: &mut Build<'_>,
    accounts: &VaultAccounts<'_>,
    amount: u64,
    min_shares: u64,
) -> Result<Outcome, ProgramError> {
    let state = vault::state(accounts.vault)?;

    if let Some(refusal) = precondition(&state, accounts, amount)? {
        return Ok(Outcome::Refused(refusal));
    }

    let Some(reserves) = build.require_accounts(&vault::reserve_addresses(&state))? else {
        return Ok(Outcome::NeedsAccounts);
    };

    if let Some(refusal) = capacity(&state, &Holdings::read(&state, reserves)?, amount, min_shares)? {
        return Ok(Outcome::Refused(refusal));
    }

    let share_mint = address(&state.shares_mint);
    build.create_associated_token_account_if_missing(
        accounts.owner_share_account,
        accounts.owner,
        &share_mint,
        &TOKEN,
    )?;

    kamino::push(build, &instruction(&state, accounts, reserves, amount, min_shares)?)?;
    build.output(share_mint.as_ref());

    Ok(Outcome::Built)
}

fn precondition(
    state: &VaultState,
    accounts: &VaultAccounts<'_>,
    amount: u64,
) -> Result<Option<Refusal>, ProgramError> {
    let balance = token_account_amount(accounts.owner_asset_account)?.unwrap_or(0);
    let checks = [
        (address(&state.token_mint) != *accounts.asset, Refusal::AssetMismatch),
        (amount == 0, Refusal::ZeroAmount),
        (amount < state.min_deposit_amount, Refusal::BelowMinimumDeposit),
        (balance < amount, Refusal::InsufficientBalance),
    ];

    Ok(checks.into_iter().find_map(|(fails, refusal)| fails.then_some(refusal)))
}

/// The shares are an estimate from the reserves as the accounts hold them. The kvault program
/// refreshes the reserves first and mints a little fewer, and its own minimum is exact.
fn capacity(
    state: &VaultState,
    holdings: &Holdings,
    amount: u64,
    min_shares: u64,
) -> Result<Option<Refusal>, ProgramError> {
    let after = holdings.aum.checked_add(u128::from(amount)).ok_or(ProgramError::ArithmeticOverflow)?;
    let shares = holdings.shares_for(u128::from(amount)).ok_or(ProgramError::ArithmeticOverflow)?;
    let checks = [
        (state.deposit_cap > 0 && after > u128::from(state.deposit_cap), Refusal::DepositCapReached),
        (shares < u128::from(min_shares), Refusal::SharesBelowMinimum),
    ];

    Ok(checks.into_iter().find_map(|(fails, refusal)| fails.then_some(refusal)))
}

fn instruction(
    state: &VaultState,
    accounts: &VaultAccounts<'_>,
    reserves: &[AccountView],
    amount: u64,
    min_shares: u64,
) -> Result<Instruction, ProgramError> {
    let deposit_accounts = DepositAccounts {
        user: pubkey(accounts.owner),
        vault_state: pubkey(accounts.vault.address()),
        token_vault: state.token_vault,
        token_mint: state.token_mint,
        base_vault_authority: state.base_vault_authority,
        shares_mint: state.shares_mint,
        user_token_ata: pubkey(accounts.owner_asset_account.address()),
        user_shares_ata: pubkey(accounts.owner_share_account.address()),
        klend_program: KLEND_PROGRAM_ID,
        token_program: state.token_program,
        shares_token_program: TOKEN_PROGRAM_ID,
    };
    let instruction = deposit(deposit_accounts, amount, vault::refresh_accounts(reserves)?);

    if min_shares == 0 {
        return Ok(instruction);
    }

    let data = [&DEPOSIT_WITH_MIN_SHARES_OUT[..], &amount.to_le_bytes(), &min_shares.to_le_bytes()].concat();

    Ok(Instruction { data, ..instruction })
}
