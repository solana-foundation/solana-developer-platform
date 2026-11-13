//! The preconditions of an earn market, which a deposit and a withdrawal share.

use pinocchio::account::AccountView;
use sdp_intents_builder::programs::TOKEN;

use crate::refusals::{
    Refusal, LIQUIDITY_UNREADABLE, NOT_A_VAULT, PROTOCOL_LOCKED, UNSUPPORTED_TOKEN_PROGRAM, VAULT_ACCOUNTS_MISMATCH,
    VAULT_ASSET_MISMATCH, VAULT_PAUSED,
};
use crate::state::{read, LendingV1, LiquidityV1, UserSupplyPositionV1, EXCHANGE_PRICE_PRECISION};
use crate::Market;

impl Market {
    /// The first precondition of the market that does not hold.
    pub(crate) fn refusal(&self) -> Option<Refusal> {
        let Some(lending) = read::<LendingV1>(&self.vault) else {
            return Some(NOT_A_VAULT);
        };

        if !same_address(&lending.mint, &self.asset) {
            return Some(VAULT_ASSET_MISMATCH);
        }

        if !self.asset.owned_by(&TOKEN) {
            return Some(UNSUPPORTED_TOKEN_PROGRAM);
        }

        if !self.is_named_by(&lending) {
            return Some(VAULT_ACCOUNTS_MISMATCH);
        }

        let (Some(liquidity), Some(position)) =
            (read::<LiquidityV1>(&self.liquidity), read::<UserSupplyPositionV1>(&self.supply_position))
        else {
            return Some(LIQUIDITY_UNREADABLE);
        };

        if liquidity.is_locked() {
            return Some(PROTOCOL_LOCKED);
        }

        position.is_paused().then_some(VAULT_PAUSED)
    }

    /// The shares that `amount` buys at the last price of the market, or `None` when the price is
    /// zero or the result does not fit a `u64`. A deposit first updates the price with the interest
    /// and the rewards since then. That update raises the price, so the deposit mints at most this
    /// many shares.
    pub(crate) fn shares_at_last_price(&self, amount: u64) -> Option<u64> {
        let lending = read::<LendingV1>(&self.vault)?;
        let price = u128::from(lending.token_exchange_price());
        let shares = u128::from(amount).checked_mul(EXCHANGE_PRICE_PRECISION)?.checked_div(price)?;

        u64::try_from(shares).ok()
    }

    fn is_named_by(&self, lending: &LendingV1) -> bool {
        same_address(&lending.f_token_mint, &self.share_mint)
            && same_address(&lending.token_reserves_liquidity, &self.token_reserve)
            && same_address(&lending.supply_position_on_liquidity, &self.supply_position)
            && same_address(&lending.rewards_rate_model, &self.rewards_rate_model)
    }
}

fn same_address(stored: &[u8; 32], account: &AccountView) -> bool {
    stored == account.address().as_array()
}
