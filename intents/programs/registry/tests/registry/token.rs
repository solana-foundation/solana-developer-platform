//! SPL Token accounts in LiteSVM, written in the layouts of the Token program.

use anchor_lang::Address;
use anchor_v2_testing::litesvm::LiteSVM;
use solana_account::Account;

use crate::svm::{failure, Failure};

pub const TOKEN_PROGRAM: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const INITIALIZED: u8 = 1;

pub fn associated_token_account(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(&[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()], &ASSOCIATED_TOKEN_PROGRAM).0
}

/// A mint of 82 bytes with no authorities and `decimals` at byte 44.
pub fn set_mint(svm: &mut LiteSVM, mint: &Address, decimals: u8) -> Result<(), Failure> {
    let data = [&[0u8; 44][..], &[decimals, INITIALIZED], &[0; 36]].concat();

    set_token_program_account(svm, mint, &data)
}

/// An initialized token account of `owner` for `mint` that holds `amount`: the mint, the owner,
/// the amount, no delegate, the state, then no native amount, delegated amount, or close
/// authority. It is 165 bytes.
pub fn set_token_account(
    svm: &mut LiteSVM,
    address: &Address,
    mint: &Address,
    owner: &Address,
    amount: u64,
) -> Result<(), Failure> {
    let no_delegate = [0u8; 36];
    let after_state = [0u8; 12 + 8 + 36];
    let data =
        [mint.as_ref(), owner.as_ref(), &amount.to_le_bytes(), &no_delegate, &[INITIALIZED], &after_state].concat();

    set_token_program_account(svm, address, &data)
}

pub fn token_amount(svm: &LiteSVM, address: &Address) -> Option<u64> {
    let data = svm.get_account(address)?.data;

    data.get(64..72)?.try_into().ok().map(u64::from_le_bytes)
}

fn set_token_program_account(svm: &mut LiteSVM, address: &Address, data: &[u8]) -> Result<(), Failure> {
    let account = Account {
        lamports: svm.minimum_balance_for_rent_exemption(data.len()),
        data: data.to_vec(),
        owner: TOKEN_PROGRAM,
        executable: false,
        rent_epoch: 0,
    };

    svm.set_account(*address, account).map_err(|error| failure(format!("{error:?}")))
}
