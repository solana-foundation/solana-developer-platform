//! The Jupiter Lend accounts that the builder reads, in their onchain layouts. The lending program
//! writes `Lending` in borsh, and the liquidity program writes its accounts packed, so every struct
//! here has alignment 1 and a reader casts the account data in place. The layouts are those of the
//! IDLs in `@jup-ag/lend` 0.4.0.

use bytemuck::{Pod, Zeroable};
use pinocchio::account::{AccountView, Ref};
use pinocchio::address::Address;

/// One earn market of the lending program. The vault input is this account.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct LendingV1 {
    pub discriminator: [u8; 8],
    pub mint: [u8; 32],
    pub f_token_mint: [u8; 32],
    pub lending_id: [u8; 2],
    pub decimals: u8,
    pub rewards_rate_model: [u8; 32],
    pub liquidity_exchange_price: [u8; 8],
    pub token_exchange_price: [u8; 8],
    pub last_update_timestamp: [u8; 8],
    pub token_reserves_liquidity: [u8; 32],
    pub supply_position_on_liquidity: [u8; 32],
    pub bump: u8,
}

/// The configuration of the liquidity program. A `status` of true locks the whole protocol.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct LiquidityV1 {
    pub discriminator: [u8; 8],
    pub authority: [u8; 32],
    pub revenue_collector: [u8; 32],
    pub status: u8,
    pub bump: u8,
}

/// The supply position of one protocol, such as a lending market, in the liquidity program. A
/// `status` other than zero means that the liquidity program paused the protocol.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct UserSupplyPositionV1 {
    pub discriminator: [u8; 8],
    pub protocol: [u8; 32],
    pub mint: [u8; 32],
    pub with_interest: u8,
    pub amount: [u8; 8],
    pub withdrawal_limit: [u8; 8],
    pub decay_amount: [u8; 8],
    pub last_update: [u8; 8],
    pub expand_pct: [u8; 2],
    pub expand_duration: [u8; 4],
    pub decay_duration: [u8; 4],
    pub base_withdrawal_limit: [u8; 8],
    pub status: u8,
}

/// An account type of a Jupiter Lend program: its owner and its Anchor discriminator.
pub trait JupiterAccount: Pod {
    const OWNER: Address;
    const DISCRIMINATOR: [u8; 8];

    fn discriminator(&self) -> &[u8; 8];
}

impl JupiterAccount for LendingV1 {
    const OWNER: Address = crate::LENDING_PROGRAM;
    const DISCRIMINATOR: [u8; 8] = [135, 199, 82, 16, 249, 131, 182, 241];

    fn discriminator(&self) -> &[u8; 8] {
        &self.discriminator
    }
}

impl JupiterAccount for LiquidityV1 {
    const OWNER: Address = crate::LIQUIDITY_PROGRAM;
    const DISCRIMINATOR: [u8; 8] = [54, 252, 249, 226, 137, 172, 121, 58];

    fn discriminator(&self) -> &[u8; 8] {
        &self.discriminator
    }
}

impl JupiterAccount for UserSupplyPositionV1 {
    const OWNER: Address = crate::LIQUIDITY_PROGRAM;
    const DISCRIMINATOR: [u8; 8] = [202, 219, 136, 118, 61, 177, 21, 146];

    fn discriminator(&self) -> &[u8; 8] {
        &self.discriminator
    }
}

impl LendingV1 {
    /// Assets per share, scaled by [`EXCHANGE_PRICE_PRECISION`], at the last update of the market.
    pub fn token_exchange_price(&self) -> u64 {
        u64::from_le_bytes(self.token_exchange_price)
    }
}

impl LiquidityV1 {
    pub fn is_locked(&self) -> bool {
        self.status != 0
    }
}

impl UserSupplyPositionV1 {
    pub fn is_paused(&self) -> bool {
        self.status != 0
    }
}

/// The scale of an exchange price: a price of `10^12` is one asset atom per share atom.
pub const EXCHANGE_PRICE_PRECISION: u128 = 1_000_000_000_000;

/// `account` as `T`, read in place, or `None` when another program owns it or its data is not a
/// `T`. A longer account is valid, because the programs can grow an account.
pub fn read<T: JupiterAccount>(account: &AccountView) -> Option<Ref<'_, T>> {
    if !account.owned_by(&T::OWNER) {
        return None;
    }

    let data = account.try_borrow().ok()?;

    Ref::filter_map(data, cast::<T>).ok()
}

fn cast<T: JupiterAccount>(data: &[u8]) -> Option<&T> {
    let value: &T = bytemuck::try_from_bytes(data.get(..core::mem::size_of::<T>())?).ok()?;

    (*value.discriminator() == T::DISCRIMINATOR).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layouts_have_the_sizes_of_the_mainnet_accounts() {
        assert_eq!(core::mem::size_of::<LendingV1>(), 196);
        assert_eq!(core::mem::size_of::<LiquidityV1>(), 74);
        assert_eq!(core::mem::size_of::<UserSupplyPositionV1>(), 124);
        assert_eq!(core::mem::align_of::<LendingV1>(), 1);
        assert_eq!(core::mem::align_of::<UserSupplyPositionV1>(), 1);
    }
}
