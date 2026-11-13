//! The checks that run before the builder adds an instruction. Each one refuses a transfer that
//! Token-2022 would fail, so a caller gets a code instead of a failed simulation.
//!
//! The mint check refuses an extension type that it does not know. A new mint extension can change
//! what the recipient receives without a failure, and the final simulation does not see that. A new
//! account extension can only stop a transfer, and the final simulation fails then, so the account
//! checks read only the extensions that they need.

use pinocchio::account::AccountView;
use pinocchio::address::Address;
use sdp_intents_builder::programs::TOKEN_2022;

use crate::refusal::{Refusal, Stop};
use crate::token_data::{kind, AccountState, Extension, Mint, TokenAccount};

const TRANSFER_HOOK_PROGRAM_OFFSET: usize = 32;
const PAUSABLE_PAUSED_OFFSET: usize = 32;
const DEFAULT_STATE_FROZEN: u8 = 2;
/// The offset of `allow_non_confidential_credits` in `ConfidentialTransferAccount`.
const NON_CONFIDENTIAL_CREDITS_OFFSET: usize = 262;

/// The accounts of the implementation, as the builder reads them.
pub struct TransferAccounts<'v> {
    pub mint: &'v AccountView,
    pub from: &'v AccountView,
    pub to: &'v AccountView,
    pub source: &'v AccountView,
    pub destination: &'v AccountView,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Destination {
    /// The destination does not exist yet, so the transfer creates it first.
    Create,
    Exists,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Preconditions {
    pub decimals: u8,
    pub hook_program: Option<Address>,
    pub destination: Destination,
}

/// What the mint's extensions require of the transfer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MintRules {
    pub hook_program: Option<Address>,
    pub freezes_new_accounts: bool,
}

pub fn check(accounts: &TransferAccounts<'_>, amount: u64, has_memo: bool) -> Result<Preconditions, Stop> {
    if !accounts.mint.owned_by(&TOKEN_2022) {
        return Err(Refusal::NotToken2022Mint.into());
    }

    let mint_data = accounts.mint.try_borrow()?;
    let mint = Mint::new(&mint_data)?;
    let rules = mint.extensions().try_fold(MintRules::default(), |rules, extension| rules.with(extension?))?;

    check_source(accounts.source, accounts.mint.address(), amount)?;

    Ok(Preconditions {
        decimals: mint.decimals()?,
        hook_program: rules.hook_program,
        destination: check_destination(accounts.destination, &rules, has_memo)?,
    })
}

impl MintRules {
    pub fn with(self, extension: Extension<'_>) -> Result<Self, Refusal> {
        match extension.kind {
            kind::NON_TRANSFERABLE => Err(Refusal::NonTransferable),
            kind::INTEREST_BEARING_CONFIG => Err(Refusal::InterestBearing),
            kind::SCALED_UI_AMOUNT => Err(Refusal::ScaledUiAmount),
            kind::PAUSABLE if flag(extension.value, PAUSABLE_PAUSED_OFFSET)? => Err(Refusal::MintPaused),
            kind::TRANSFER_HOOK => Ok(Self { hook_program: hook_program(extension.value)?, ..self }),
            kind::DEFAULT_ACCOUNT_STATE => {
                let state = extension.value.first().ok_or(Refusal::InvalidTokenData)?;

                Ok(Self { freezes_new_accounts: *state == DEFAULT_STATE_FROZEN, ..self })
            }
            kind::PAUSABLE
            | kind::TRANSFER_FEE_CONFIG
            | kind::MINT_CLOSE_AUTHORITY
            | kind::CONFIDENTIAL_TRANSFER_MINT
            | kind::PERMANENT_DELEGATE
            | kind::CONFIDENTIAL_TRANSFER_FEE_CONFIG
            | kind::METADATA_POINTER
            | kind::TOKEN_METADATA
            | kind::GROUP_POINTER
            | kind::TOKEN_GROUP
            | kind::GROUP_MEMBER_POINTER
            | kind::TOKEN_GROUP_MEMBER
            | kind::CONFIDENTIAL_MINT_BURN
            | kind::PERMISSIONED_BURN => Ok(self),
            _ => Err(Refusal::UnsupportedExtension),
        }
    }
}

/// The program of a `TransferHook` extension. An all-zero program means no hook.
fn hook_program(value: &[u8]) -> Result<Option<Address>, Refusal> {
    let program = value.get(TRANSFER_HOOK_PROGRAM_OFFSET..).and_then(|rest| rest.first_chunk::<32>());
    let program = program.ok_or(Refusal::InvalidTokenData)?;

    Ok((*program != [0; 32]).then(|| Address::new_from_array(*program)))
}

fn flag(value: &[u8], offset: usize) -> Result<bool, Refusal> {
    value.get(offset).map(|byte| *byte != 0).ok_or(Refusal::InvalidTokenData)
}

fn check_source(source: &AccountView, mint: &Address, amount: u64) -> Result<(), Stop> {
    if !source.owned_by(&TOKEN_2022) {
        return Err(Refusal::NoSourceAccount.into());
    }

    let data = source.try_borrow()?;
    let account = TokenAccount::new(&data)?;

    if account.mint()? != *mint {
        return Err(Refusal::InvalidTokenData.into());
    }

    match account.state()? {
        AccountState::Uninitialized => return Err(Refusal::NoSourceAccount.into()),
        AccountState::Frozen => return Err(Refusal::SourceFrozen.into()),
        AccountState::Initialized => {}
    }

    if account.amount()? < amount {
        return Err(Refusal::InsufficientFunds.into());
    }

    Ok(())
}

/// An account at the destination address that Token-2022 does not own is not a token account yet.
/// It can hold lamports, and the ATA program still creates the token account there.
fn check_destination(destination: &AccountView, rules: &MintRules, has_memo: bool) -> Result<Destination, Stop> {
    if !destination.owned_by(&TOKEN_2022) {
        if rules.freezes_new_accounts {
            return Err(Refusal::DestinationFrozen.into());
        }

        return Ok(Destination::Create);
    }

    let data = destination.try_borrow()?;
    let account = TokenAccount::new(&data)?;

    match account.state()? {
        AccountState::Uninitialized => return Err(Refusal::InvalidTokenData.into()),
        AccountState::Frozen => return Err(Refusal::DestinationFrozen.into()),
        AccountState::Initialized => {}
    }

    if !has_memo && requires_memo(&account)? {
        return Err(Refusal::MemoRequired.into());
    }

    if !accepts_non_confidential_credits(&account)? {
        return Err(Refusal::ConfidentialOnly.into());
    }

    Ok(Destination::Exists)
}

fn requires_memo(account: &TokenAccount<'_>) -> Result<bool, Stop> {
    match account.extensions().find(kind::MEMO_TRANSFER)? {
        Some(value) => Ok(flag(value, 0)?),
        None => Ok(false),
    }
}

fn accepts_non_confidential_credits(account: &TokenAccount<'_>) -> Result<bool, Stop> {
    match account.extensions().find(kind::CONFIDENTIAL_TRANSFER_ACCOUNT)? {
        Some(value) => Ok(flag(value, NON_CONFIDENTIAL_CREDITS_OFFSET)?),
        None => Ok(true),
    }
}

#[cfg(test)]
mod tests {
    use core::mem::offset_of;

    use spl_token_2022_interface::extension::confidential_transfer::ConfidentialTransferAccount;
    use spl_token_2022_interface::extension::pausable::PausableConfig;
    use spl_token_2022_interface::extension::transfer_hook::TransferHook;

    use super::*;

    fn extension(kind: u16, value: &[u8]) -> Extension<'_> {
        Extension { kind, value }
    }

    #[test]
    fn the_extension_offsets_are_those_of_the_interface() {
        assert_eq!(offset_of!(TransferHook, program_id), TRANSFER_HOOK_PROGRAM_OFFSET);
        assert_eq!(offset_of!(PausableConfig, paused), PAUSABLE_PAUSED_OFFSET);
        assert_eq!(
            offset_of!(ConfidentialTransferAccount, allow_non_confidential_credits),
            NON_CONFIDENTIAL_CREDITS_OFFSET
        );
    }

    #[test]
    fn the_mint_rules_follow_the_extensions() {
        let hook = [[0; 32], [5; 32]].concat();
        let rules = MintRules::default();

        assert_eq!(
            rules.with(extension(kind::TRANSFER_HOOK, &hook)),
            Ok(MintRules { hook_program: Some(Address::new_from_array([5; 32])), freezes_new_accounts: false })
        );
        assert_eq!(rules.with(extension(kind::TRANSFER_HOOK, &[0; 64])), Ok(rules));
        assert_eq!(
            rules.with(extension(kind::DEFAULT_ACCOUNT_STATE, &[DEFAULT_STATE_FROZEN])),
            Ok(MintRules { hook_program: None, freezes_new_accounts: true })
        );
        assert_eq!(rules.with(extension(kind::PERMANENT_DELEGATE, &[1; 32])), Ok(rules));
        assert_eq!(rules.with(extension(kind::TRANSFER_FEE_CONFIG, &[0; 108])), Ok(rules));
    }

    #[test]
    fn the_mint_rules_refuse_what_stops_a_transfer() {
        let rules = MintRules::default();
        let paused = [[0; 32].as_slice(), &[1]].concat();

        assert_eq!(rules.with(extension(kind::NON_TRANSFERABLE, &[])), Err(Refusal::NonTransferable));
        assert_eq!(rules.with(extension(kind::PAUSABLE, &paused)), Err(Refusal::MintPaused));
        assert_eq!(rules.with(extension(kind::PAUSABLE, &[0; 33])), Ok(rules));
        assert_eq!(rules.with(extension(kind::INTEREST_BEARING_CONFIG, &[0; 52])), Err(Refusal::InterestBearing));
        assert_eq!(rules.with(extension(kind::SCALED_UI_AMOUNT, &[0; 56])), Err(Refusal::ScaledUiAmount));
        assert_eq!(rules.with(extension(kind::MEMO_TRANSFER, &[1])), Err(Refusal::UnsupportedExtension));
        assert_eq!(rules.with(extension(kind::PERMISSIONED_BURN + 1, &[])), Err(Refusal::UnsupportedExtension));
        assert_eq!(rules.with(extension(kind::TRANSFER_HOOK, &[0; 40])), Err(Refusal::InvalidTokenData));
    }
}
