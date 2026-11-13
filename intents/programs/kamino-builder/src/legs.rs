//! The legs of a withdrawal: the shares that each kvault `withdraw` burns. One `withdraw` takes the
//! vault's available tokens first, then disinvests the rest from the one reserve that it names.
//!
//! The plan follows the klend SDK. The first leg takes the available tokens. The reserves follow in
//! order of the most tokens that the vault can withdraw from them. Each leg but the last burns the
//! shares that its tokens are worth, rounded down, and the last leg burns the rest of the shares.

use alloc::vec::Vec;
use core::cmp::Reverse;
use core::iter::once;

use pinocchio::error::ProgramError;

use crate::vault::Holdings;

/// The tokens that the vault can withdraw from the reserve at `position` in the vault's reserves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Withdrawable {
    pub(crate) position: usize,
    pub(crate) tokens: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Leg {
    pub(crate) position: usize,
    pub(crate) shares: u64,
}

/// The caller checks first that the vault and the reserves hold the tokens that `shares` are worth.
pub(crate) fn plan(holdings: &Holdings, withdrawable: &[Withdrawable], shares: u64) -> Result<Vec<Leg>, ProgramError> {
    let tokens = holdings.tokens_for(shares).ok_or(ProgramError::ArithmeticOverflow)?;
    let available = u128::from(holdings.token_available);

    let Some(from_reserves) = tokens.checked_sub(available).filter(|tokens| *tokens > 0) else {
        return Ok(Vec::from([Leg { position: 0, shares }]));
    };

    let draws = draws(withdrawable, from_reserves);
    let drawn = draws.iter().try_fold(0u128, |sum, draw| sum.checked_add(draw.tokens));

    if drawn != Some(from_reserves) {
        return Err(ProgramError::InsufficientFunds);
    }

    let (last, earlier) = draws.split_last().ok_or(ProgramError::InsufficientFunds)?;
    let earlier_legs = earlier
        .iter()
        .enumerate()
        .map(|(index, draw)| {
            let tokens = if index == 0 { draw.tokens.checked_add(available) } else { Some(draw.tokens) };
            let shares =
                tokens.and_then(|tokens| holdings.shares_for(tokens)).ok_or(ProgramError::ArithmeticOverflow)?;

            Ok(Leg {
                position: draw.position,
                shares: u64::try_from(shares).map_err(|_| ProgramError::ArithmeticOverflow)?,
            })
        })
        .collect::<Result<Vec<_>, ProgramError>>()?;

    let earlier_shares = earlier_legs.iter().try_fold(0u64, |sum, leg| sum.checked_add(leg.shares));
    let last_shares = earlier_shares.and_then(|earlier| shares.checked_sub(earlier)).filter(|shares| *shares > 0);
    let last_leg = Leg { position: last.position, shares: last_shares.ok_or(ProgramError::ArithmeticOverflow)? };

    Ok(earlier_legs.into_iter().chain(once(last_leg)).collect())
}

/// The tokens that each reserve gives, most first, until `tokens` are drawn.
fn draws(withdrawable: &[Withdrawable], tokens: u128) -> Vec<Withdrawable> {
    let mut most_first: Vec<Withdrawable> = withdrawable.to_vec();
    most_first.sort_by_key(|reserve| Reverse(reserve.tokens));

    most_first
        .into_iter()
        .scan(tokens, |left, reserve| {
            let draw = reserve.tokens.min(*left);
            *left = left.saturating_sub(draw);

            Some(Withdrawable { position: reserve.position, tokens: draw })
        })
        .take_while(|draw| draw.tokens > 0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two tokens for each share, with 100 tokens available.
    fn holdings() -> Holdings {
        Holdings { aum: 2_000, shares_issued: 1_000, token_available: 100 }
    }

    fn reserve(position: usize, tokens: u128) -> Withdrawable {
        Withdrawable { position, tokens }
    }

    #[test]
    fn a_withdrawal_that_the_available_tokens_cover_is_one_leg_on_the_first_reserve() {
        let legs = plan(&holdings(), &[reserve(0, 0), reserve(1, 500)], 50).unwrap();

        assert_eq!(legs, [Leg { position: 0, shares: 50 }]);
    }

    #[test]
    fn the_reserve_with_the_most_liquidity_takes_the_first_leg() {
        let legs = plan(&holdings(), &[reserve(0, 300), reserve(1, 900)], 400).unwrap();

        assert_eq!(legs, [Leg { position: 1, shares: 400 }]);
    }

    #[test]
    fn the_legs_split_across_reserves_and_the_last_burns_the_rest() {
        let legs = plan(&holdings(), &[reserve(0, 301), reserve(1, 400), reserve(2, 0)], 351).unwrap();

        assert_eq!(legs, [Leg { position: 1, shares: 250 }, Leg { position: 0, shares: 101 }]);
    }

    #[test]
    fn a_withdrawal_that_the_reserves_cannot_cover_is_an_error() {
        let failed = plan(&holdings(), &[reserve(0, 100)], 500);

        assert_eq!(failed, Err(ProgramError::InsufficientFunds));
    }
}
