use alloc::vec::Vec;

use pinocchio::address::Address;
use sdp_intents_builder::programs::TOKEN_2022;
use sdp_intents_builder::token::TransferChecked;
use sdp_intents_builder::{Build, BuildError};

use crate::hook::hook_accounts;
use crate::preconditions::{self, Destination, TransferAccounts};
use crate::refusal::Stop;

/// Adds the instructions of the transfer: the destination ATA when it does not exist, the memo, and
/// `transferChecked` with the accounts of the mint's transfer hook. It adds nothing when it asks
/// for hook accounts.
///
/// The memo comes right before the transfer, because a destination that requires memos reads the
/// instruction before the transfer. The memo has no signer.
pub fn build_transfer<'a: 'v, 'v>(
    build: &mut Build<'a>,
    accounts: &TransferAccounts<'v>,
    amount: u64,
    memo: Option<&str>,
) -> Result<(), Stop> {
    let mint = accounts.mint.address();
    let to = accounts.to.address();

    let source = build.associated_token_address(accounts.from.address(), mint, &TOKEN_2022)?;
    check_address(accounts.source.address(), Some(source))?;

    let preconditions = preconditions::check(accounts, amount, memo.is_some())?;

    let extra_accounts = match &preconditions.hook_program {
        Some(program) => match hook_accounts(build, accounts, program, amount)? {
            Some(metas) => metas,
            None => return Ok(()),
        },
        None => Vec::new(),
    };

    let destination = match preconditions.destination {
        Destination::Create => Some(build.create_associated_token_account_idempotent(to, mint, &TOKEN_2022)?),
        Destination::Exists => Some(build.associated_token_address(to, mint, &TOKEN_2022)?),
    };

    check_address(accounts.destination.address(), destination)?;

    if let Some(memo) = memo {
        build.memo(&[], memo.as_bytes())?;
    }

    build.transfer_checked(&TransferChecked {
        token_program: &TOKEN_2022,
        source: accounts.source.address(),
        mint,
        destination: accounts.destination.address(),
        authority: accounts.from.address(),
        amount,
        decimals: preconditions.decimals,
        extra_accounts: &extra_accounts,
    })?;

    Ok(())
}

/// The record derives the source and the destination, so another account is a caller error.
fn check_address(given: &Address, derived: Option<Address>) -> Result<(), BuildError> {
    if derived.as_ref() != Some(given) {
        return Err(BuildError::WrongAccounts);
    }

    Ok(())
}
