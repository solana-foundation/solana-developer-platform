//! The token instructions that builders add most, for SPL Token and Token-2022. Both programs use
//! the same layout for these instructions and for the base of a mint and a token account.

use pinocchio::account::AccountView;
use pinocchio::address::Address;

use crate::programs::{ASSOCIATED_TOKEN, SYSTEM, TOKEN, TOKEN_2022};
use crate::{Build, BuildError, Meta};

const CREATE_IDEMPOTENT: u8 = 1;
const TRANSFER_CHECKED: u8 = 12;
/// A mint's decimals are byte 44 of its data.
const MINT_DECIMALS_OFFSET: usize = 44;
const TOKEN_ACCOUNT_AMOUNT_OFFSET: usize = 64;

/// The seeds of the associated token account of `owner` for `mint`.
pub(crate) fn ata_seeds<'s>(owner: &'s Address, mint: &'s Address, token_program: &'s Address) -> [&'s [u8]; 3] {
    [owner.as_ref(), token_program.as_ref(), mint.as_ref()]
}

/// The decimals of a mint of either token program.
pub fn mint_decimals(mint: &AccountView) -> Result<u8, BuildError> {
    let data = mint.try_borrow().map_err(|_| BuildError::WrongAccounts)?;

    data.get(MINT_DECIMALS_OFFSET).copied().ok_or(BuildError::WrongAccounts)
}

/// The amount in a token account of either token program, or `None` when the account does not
/// exist: it holds no lamports. An account that exists and that no token program owns is an error.
/// The caller checks the mint and the token owner.
pub fn token_account_amount(account: &AccountView) -> Result<Option<u64>, BuildError> {
    if account.lamports() == 0 {
        return Ok(None);
    }

    if !(account.owned_by(&TOKEN) || account.owned_by(&TOKEN_2022)) {
        return Err(BuildError::WrongAccounts);
    }

    let data = account.try_borrow().map_err(|_| BuildError::WrongAccounts)?;
    let amount = data.get(TOKEN_ACCOUNT_AMOUNT_OFFSET..).and_then(|rest| rest.first_chunk::<8>());

    amount.map(|bytes| Some(u64::from_le_bytes(*bytes))).ok_or(BuildError::WrongAccounts)
}

impl Build<'_> {
    /// The associated token account of `owner` for `mint`, derived with the next bump, as
    /// [`Build::program_address`] derives it.
    pub fn associated_token_address(
        &mut self,
        owner: &Address,
        mint: &Address,
        token_program: &Address,
    ) -> Result<Address, BuildError> {
        self.program_address(&ata_seeds(owner, mint, token_program), &ASSOCIATED_TOKEN)
    }

    /// Creates the associated token account of `owner` for `mint` when it does not exist, with the
    /// rent payer funding it. Returns its address.
    pub fn create_associated_token_account_idempotent(
        &mut self,
        owner: &Address,
        mint: &Address,
        token_program: &Address,
    ) -> Result<Address, BuildError> {
        let account = self.associated_token_address(owner, mint, token_program)?;

        self.create_associated_token_account_idempotent_at(&account, owner, mint, token_program)?;

        Ok(account)
    }

    /// The same instruction for an `account` that the caller already holds, such as an associated
    /// token account that the implementation derives. It saves the derivation. The ATA program checks
    /// that `account` is the associated token account of `owner` and `mint`.
    pub fn create_associated_token_account_idempotent_at(
        &mut self,
        account: &Address,
        owner: &Address,
        mint: &Address,
        token_program: &Address,
    ) -> Result<(), BuildError> {
        let accounts = [
            Meta::rent_payer(),
            Meta::writable(account),
            Meta::readonly(owner),
            Meta::readonly(mint),
            Meta::readonly(&SYSTEM),
            Meta::readonly(token_program),
        ];

        self.instruction(&ASSOCIATED_TOKEN, &accounts, &[CREATE_IDEMPOTENT])
    }

    /// Creates `account`, the associated token account of `owner` for `mint`, only when it holds no
    /// lamports. The planner refuses an instruction that names a payer and creates no account, so a
    /// builder that reads the account adds the create only when it is needed. The ATA program checks
    /// the address.
    pub fn create_associated_token_account_if_missing(
        &mut self,
        account: &AccountView,
        owner: &Address,
        mint: &Address,
        token_program: &Address,
    ) -> Result<(), BuildError> {
        if account.lamports() > 0 {
            return Ok(());
        }

        self.create_associated_token_account_idempotent_at(account.address(), owner, mint, token_program)
    }

    /// `transferChecked`, with `extra_accounts` after the four that it names, such as the accounts
    /// of a Token-2022 transfer hook.
    pub fn transfer_checked(&mut self, transfer: &TransferChecked<'_>) -> Result<(), BuildError> {
        let base = [
            Meta::writable(transfer.source),
            Meta::readonly(transfer.mint),
            Meta::writable(transfer.destination),
            Meta::signer(transfer.authority),
        ];
        let accounts: alloc::vec::Vec<Meta> = base.into_iter().chain(transfer.extra_accounts.iter().copied()).collect();
        let data = [&[TRANSFER_CHECKED][..], &transfer.amount.to_le_bytes(), &[transfer.decimals]].concat();

        self.instruction(transfer.token_program, &accounts, &data)
    }

    /// A memo of the Memo program v2, signed by `signers`.
    pub fn memo(&mut self, signers: &[&Address], text: &[u8]) -> Result<(), BuildError> {
        let accounts: alloc::vec::Vec<Meta> = signers.iter().map(|signer| Meta::signer(signer)).collect();

        self.instruction(&crate::programs::MEMO, &accounts, text)
    }
}

/// The accounts and values of a `transferChecked`.
pub struct TransferChecked<'a> {
    pub token_program: &'a Address,
    pub source: &'a Address,
    pub mint: &'a Address,
    pub destination: &'a Address,
    pub authority: &'a Address,
    pub amount: u64,
    pub decimals: u8,
    pub extra_accounts: &'a [Meta],
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(text: &str) -> Address {
        Address::from_str_const(text)
    }

    #[test]
    fn derives_a_known_mainnet_associated_token_account() {
        let owner = address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
        let usdc = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

        let found = Address::try_find_program_address(&ata_seeds(&owner, &usdc, &TOKEN), &ASSOCIATED_TOKEN);

        assert_eq!(found.map(|(address, _)| address), Some(address("FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B")));
    }

    #[test]
    fn the_program_constants_are_their_addresses() {
        assert_eq!(TOKEN, address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
        assert_eq!(crate::programs::TOKEN_2022, address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"));
        assert_eq!(ASSOCIATED_TOKEN, address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"));
        assert_eq!(crate::programs::MEMO, address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"));
    }
}
