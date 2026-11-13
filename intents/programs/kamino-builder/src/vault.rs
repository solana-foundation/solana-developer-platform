//! The kvault vault state, read in place, and what the vault holds across its reserves.

use alloc::vec::Vec;

use kvault_interface::state::{VaultAllocation, VaultState};
use kvault_interface::util::{readonly, writable};
use pinocchio::account::{AccountView, Ref};
use pinocchio::address::Address;
use pinocchio::error::ProgramError;
use solana_instruction_2::AccountMeta;
use solana_pubkey::Pubkey;

use crate::kamino::{address, pubkey, KVAULT};
use crate::reserve::{self, FRACTION_BITS};

/// The accounts of the implementation that the build reads.
pub(crate) struct VaultAccounts<'a> {
    pub(crate) vault: &'a AccountView,
    pub(crate) owner: &'a Address,
    pub(crate) asset: &'a Address,
    pub(crate) owner_asset_account: &'a AccountView,
    pub(crate) owner_share_account: &'a AccountView,
}

pub(crate) fn state(vault: &AccountView) -> Result<Ref<'_, VaultState>, ProgramError> {
    if !vault.owned_by(&KVAULT) {
        return Err(ProgramError::InvalidAccountOwner);
    }

    Ref::try_map(vault.try_borrow()?, kvault_interface::from_account_data::<VaultState>)
        .map_err(|_| ProgramError::InvalidAccountData)
}

/// The allocations that name a reserve, in slot order. Every kvault instruction names their
/// reserves in this order, and `require_accounts` returns the reserves in it.
pub(crate) fn allocations(state: &VaultState) -> impl Iterator<Item = &VaultAllocation> {
    state.vault_allocation_strategy.iter().filter(|allocation| allocation.reserve != Pubkey::default())
}

pub(crate) fn reserve_addresses(state: &VaultState) -> Vec<Address> {
    allocations(state).map(|allocation| address(&allocation.reserve)).collect()
}

/// The remaining accounts of a kvault instruction, which the kvault program refreshes by CPI: each
/// reserve, writable, then each lending market.
pub(crate) fn refresh_accounts(reserves: &[AccountView]) -> Result<Vec<AccountMeta>, ProgramError> {
    let lending_markets = reserves
        .iter()
        .map(|view| reserve::state(view).map(|reserve| readonly(reserve.lending_market)))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(reserves.iter().map(|view| writable(pubkey(view.address()))).chain(lending_markets).collect())
}

/// What the vault holds, in tokens, against the shares that it issued. The reserves are as the
/// accounts hold them, so the kvault program, which refreshes them first, can find more.
pub(crate) struct Holdings {
    pub(crate) aum: u128,
    pub(crate) shares_issued: u64,
    pub(crate) token_available: u64,
}

impl Holdings {
    /// `reserves` are the reserves of [`allocations`], in order.
    pub(crate) fn read(state: &VaultState, reserves: &[AccountView]) -> Result<Self, ProgramError> {
        let invested = allocations(state).zip(reserves).try_fold(0u128, |sum, (allocation, view)| {
            let reserve = reserve::state(view)?;

            reserve::invested(allocation, &reserve)
                .and_then(|tokens| sum.checked_add(tokens))
                .ok_or(ProgramError::ArithmeticOverflow)
        })?;
        let pending_fees = u128::from(state.pending_fees_sf).checked_shr(FRACTION_BITS);
        let aum = pending_fees
            .and_then(|fees| u128::from(state.token_available).checked_add(invested)?.checked_sub(fees))
            .ok_or(ProgramError::ArithmeticOverflow)?;

        Ok(Self { aum, shares_issued: state.shares_issued, token_available: state.token_available })
    }

    /// With no shares or no tokens, one share counts as one token.
    pub(crate) fn tokens_for(&self, shares: u64) -> Option<u128> {
        if self.shares_issued == 0 {
            return Some(u128::from(shares));
        }

        u128::from(shares).checked_mul(self.aum)?.checked_div(u128::from(self.shares_issued))
    }

    pub(crate) fn shares_for(&self, tokens: u128) -> Option<u128> {
        if self.aum == 0 {
            return Some(tokens);
        }

        tokens.checked_mul(u128::from(self.shares_issued))?.checked_div(self.aum)
    }
}
