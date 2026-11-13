//! A klend reserve, read in place, and what the vault holds in it.

use klend_interface::state::Reserve;
use kvault_interface::state::VaultAllocation;
use pinocchio::account::{AccountView, Ref};
use pinocchio::error::ProgramError;
use solana_pubkey::Pubkey;

use crate::kamino::KLEND;

/// The fraction bits of the klend scaled fractions, the fields that end in `_sf`.
pub(crate) const FRACTION_BITS: u32 = 60;

pub(crate) fn state(reserve: &AccountView) -> Result<Ref<'_, Reserve>, ProgramError> {
    if !reserve.owned_by(&KLEND) {
        return Err(ProgramError::InvalidAccountOwner);
    }

    Ref::try_map(reserve.try_borrow()?, klend_interface::state::from_account_data::<Reserve>)
        .map_err(|_| ProgramError::InvalidAccountData)
}

/// The tokens that the vault's collateral in `reserve` redeems for, as klend prices collateral:
/// what the reserve holds and lends, less its fees, for each collateral token.
pub(crate) fn invested(allocation: &VaultAllocation, reserve: &Reserve) -> Option<u128> {
    let supply = reserve.collateral.mint_total_supply;

    if supply == 0 {
        return Some(0);
    }

    u128::from(allocation.ctoken_allocation).checked_mul(total_liquidity(reserve)?)?.checked_div(u128::from(supply))
}

/// What the vault can withdraw from `reserve` now: its invested tokens, at most the liquidity that
/// the reserve does not lend.
pub(crate) fn withdrawable(allocation: &VaultAllocation, reserve: &Reserve) -> Option<u128> {
    let available = u128::from(reserve.liquidity.total_available_amount);

    invested(allocation, reserve).map(|invested| invested.min(available))
}

pub(crate) fn lending_market_authority(lending_market: &Pubkey) -> Pubkey {
    klend_interface::pda::lending_market_authority(&klend_interface::KLEND_PROGRAM_ID, lending_market).0
}

/// In whole token units. The scaled fractions lose less than one unit here.
fn total_liquidity(reserve: &Reserve) -> Option<u128> {
    let liquidity = &reserve.liquidity;
    let fees = [
        liquidity.accumulated_protocol_fees_sf,
        liquidity.accumulated_referrer_fees_sf,
        liquidity.pending_referrer_fees_sf,
    ]
    .into_iter()
    .try_fold(0u128, |sum, fee| sum.checked_add(u128::from(fee)))?;

    u128::from(liquidity.total_available_amount)
        .checked_shl(FRACTION_BITS)?
        .checked_add(u128::from(liquidity.borrowed_amount_sf))?
        .checked_sub(fees)?
        .checked_shr(FRACTION_BITS)
}
