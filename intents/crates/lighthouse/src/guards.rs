//! Which values the assertions guard, and the least change that each may show. A value is guarded
//! when a postcondition bounds it and the span can change it.
//!
//! The span can change an account only when a built instruction names it writable, or when it is
//! the fee payer, which the runtime makes a writable signer everywhere. Those are the guarded
//! accounts. The rent payer may also spend up to the rent cap on new accounts, so its lamport bound
//! allows the cap.

use alloc::vec::Vec;

use sdp_intents_engine::{associated_token_account, Condition, Payers};
use sdp_intents_spec::Address;

use crate::GuardError;

/// `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.
const TOKEN_PROGRAM: Address = Address([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145,
    58, 140, 245, 133, 126, 255, 0, 169,
]);
/// `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`.
const TOKEN_2022_PROGRAM: Address = Address([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77, 131, 185, 13, 39, 254,
    189, 249, 40, 216, 161, 139, 252,
]);
/// The System program's address names SOL as a mint.
const SOL: Address = Address([0; 32]);
const TOKEN_ACCOUNT_LEN: usize = 165;
/// Token-2022 writes the account type after the base account. `2` is a token account.
const TOKEN_2022_ACCOUNT_TYPE: u8 = 2;

/// An account that the span can change, with its state before the span.
#[derive(Clone, Copy, Debug)]
pub struct GuardedAccount<'a> {
    pub address: Address,
    pub owner: Address,
    pub lamports: u64,
    pub data: &'a [u8],
}

/// The guarded values, in the order of the guarded accounts.
pub(crate) struct Guards {
    pub(crate) lamports: Vec<LamportGuard>,
    pub(crate) tokens: Vec<TokenGuard>,
    pub(crate) new_accounts: Vec<NewAccountGuard>,
}

pub(crate) struct LamportGuard {
    pub(crate) address: Address,
    pub(crate) min_change: i128,
}

/// A token account that existed before the span. `min_change` bounds its amount, and
/// `authorities_fixed` keeps its owner, delegate, and close authority.
pub(crate) struct TokenGuard {
    pub(crate) address: Address,
    pub(crate) min_change: Option<i128>,
    pub(crate) authorities_fixed: bool,
}

/// An associated token account that the span creates and that an inflow must reach.
pub(crate) struct NewAccountGuard {
    pub(crate) address: Address,
    pub(crate) min: u64,
}

/// What a token account holds, read from its data.
#[derive(Clone, Copy)]
struct Holding {
    mint: Address,
    authority: Address,
}

pub(crate) struct GuardInputs<'g> {
    pub(crate) conditions: &'g [Condition],
    pub(crate) accounts: &'g [GuardedAccount<'g>],
    pub(crate) payers: Payers<'g>,
    pub(crate) rent_cap: u64,
}

impl GuardInputs<'_> {
    pub(crate) fn guards(&self) -> Result<Guards, GuardError> {
        self.check_single_accounts()?;

        let lamports = self
            .accounts
            .iter()
            .filter_map(|account| {
                self.lamport_bound(&account.address)
                    .map(|bound| bound.map(|min_change| LamportGuard { address: account.address, min_change }))
                    .transpose()
            })
            .collect::<Result<Vec<_>, _>>()?;
        let tokens = self
            .accounts
            .iter()
            .filter_map(|account| holding(account).map(|held| self.token_guard(&account.address, held)))
            .filter_map(Result::transpose)
            .collect::<Result<Vec<_>, _>>()?;
        let new_accounts = self.new_account_guards()?;

        Ok(Guards { lamports, tokens, new_accounts })
    }

    /// The least lamport change of `address`: the strictest bound of every SOL postcondition on it.
    fn lamport_bound(&self, address: &Address) -> Result<Option<i128>, GuardError> {
        let allowance = if address == self.payers.rent { self.rent_cap } else { 0 };
        let sol_outflow = self.conditions.iter().any(|condition| is_outflow(condition, address, &SOL));

        self.conditions.iter().try_fold(None, |bound, condition| {
            let next = match *condition {
                Condition::Outflow { from, mint, max } if from == *address && mint == SOL => {
                    Some(negate(add(max, allowance)?)?)
                }
                Condition::NoOtherOutflows { from } if from == *address && !sol_outflow => {
                    Some(negate(u128::from(allowance))?)
                }
                Condition::Inflow { to, mint, min } if to == *address && mint == SOL => {
                    Some(signed(min)?.checked_sub(i128::from(allowance)).ok_or(GuardError::Overflow)?)
                }
                _ => None,
            };

            Ok(stricter(bound, next))
        })
    }

    fn token_guard(&self, address: &Address, held: Holding) -> Result<Option<TokenGuard>, GuardError> {
        let owner = &held.authority;
        let outflow = self.conditions.iter().any(|condition| is_outflow(condition, owner, &held.mint));

        let min_change = self.conditions.iter().try_fold(None, |bound, condition| {
            let next = match *condition {
                Condition::Outflow { from, mint, max } if from == *owner && mint == held.mint => Some(negate(max)?),
                Condition::NoOtherOutflows { from } if from == *owner && !outflow => Some(0),
                Condition::Inflow { to, mint, min } if to == *owner && mint == held.mint => Some(signed(min)?),
                _ => None,
            };

            Ok::<_, GuardError>(stricter(bound, next))
        })?;

        let authorities_fixed = self
            .conditions
            .iter()
            .any(|condition| matches!(condition, Condition::NoAuthorityChange { owner: fixed } if fixed == owner));

        Ok((min_change.is_some() || authorities_fixed).then_some(TokenGuard {
            address: *address,
            min_change,
            authorities_fixed,
        }))
    }

    /// A token inflow to an owner with no token account of the mint before the span must reach the
    /// owner's associated token account, which the span creates.
    fn new_account_guards(&self) -> Result<Vec<NewAccountGuard>, GuardError> {
        self.conditions
            .iter()
            .filter_map(|condition| match *condition {
                Condition::Inflow { to, mint, min } if mint != SOL && min > 0 && self.holdings(&to, &mint) == 0 => {
                    Some(self.new_account(&to, &mint, min))
                }
                Condition::Inflow { to, mint: SOL, min } if min > 0 && !self.guarded(&to) => {
                    Some(Err(GuardError::NoInflowAccount))
                }
                _ => None,
            })
            .collect()
    }

    fn new_account(&self, owner: &Address, mint: &Address, min: u128) -> Result<NewAccountGuard, GuardError> {
        let min = u64::try_from(min).map_err(|_| GuardError::Overflow)?;
        let created = |token_program: &Address| {
            let address = associated_token_account(owner, mint, token_program)?;

            self.accounts.iter().find(|account| account.address == address && account.data.is_empty())
        };
        let mut candidates = [created(&TOKEN_PROGRAM), created(&TOKEN_2022_PROGRAM)].into_iter().flatten();

        match (candidates.next(), candidates.next()) {
            (Some(account), None) => Ok(NewAccountGuard { address: account.address, min }),
            _ => Err(GuardError::NoInflowAccount),
        }
    }

    /// An outflow or an inflow of a token is bounded on one account, because Lighthouse cannot
    /// sum the changes of several.
    fn check_single_accounts(&self) -> Result<(), GuardError> {
        let several = self.conditions.iter().any(|condition| match *condition {
            Condition::Outflow { from, mint, .. } if mint != SOL => self.holdings(&from, &mint) > 1,
            Condition::Inflow { to, mint, .. } if mint != SOL => self.holdings(&to, &mint) > 1,
            _ => false,
        });

        if several {
            return Err(GuardError::SeveralAccounts);
        }

        Ok(())
    }

    fn holdings(&self, owner: &Address, mint: &Address) -> usize {
        self.accounts.iter().filter_map(holding).filter(|held| held.authority == *owner && held.mint == *mint).count()
    }

    fn guarded(&self, address: &Address) -> bool {
        self.accounts.iter().any(|account| account.address == *address)
    }
}

/// The mint and the owner of a token account. A Token-2022 mint with extensions is as long as a
/// token account, so its account type tells them apart.
fn holding(account: &GuardedAccount<'_>) -> Option<Holding> {
    let token_program = account.owner == TOKEN_PROGRAM || account.owner == TOKEN_2022_PROGRAM;
    let token_account = match account.data.get(TOKEN_ACCOUNT_LEN) {
        None => account.data.len() == TOKEN_ACCOUNT_LEN,
        Some(account_type) => *account_type == TOKEN_2022_ACCOUNT_TYPE,
    };

    if !(token_program && token_account) {
        return None;
    }

    Some(Holding {
        mint: Address(*account.data.first_chunk::<32>()?),
        authority: Address(*account.data.get(32..)?.first_chunk::<32>()?),
    })
}

fn is_outflow(condition: &Condition, address: &Address, of: &Address) -> bool {
    matches!(condition, Condition::Outflow { from, mint, .. } if from == address && mint == of)
}

/// Every bound must hold, so the strictest is the greatest.
fn stricter(bound: Option<i128>, next: Option<i128>) -> Option<i128> {
    match (bound, next) {
        (Some(bound), Some(next)) => Some(bound.max(next)),
        (bound, next) => bound.or(next),
    }
}

fn add(value: u128, allowance: u64) -> Result<u128, GuardError> {
    value.checked_add(u128::from(allowance)).ok_or(GuardError::Overflow)
}

fn signed(value: u128) -> Result<i128, GuardError> {
    i128::try_from(value).map_err(|_| GuardError::Overflow)
}

fn negate(value: u128) -> Result<i128, GuardError> {
    signed(value)?.checked_neg().ok_or(GuardError::Overflow)
}
