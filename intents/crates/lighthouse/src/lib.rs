//! The Lighthouse assertions that guard an intent's postconditions onchain. The planner adds them
//! to each segment, and `verify_intent` builds them again and compares them byte for byte. So both
//! build them from the same inputs: the resolved postconditions, the accounts that the span can
//! change with their state before the span, the rent cap, and the memory account.
//!
//! ```text
//! [verify_intent] [snapshot × S] [built × N] [assertion × M, then close memory]
//! ```
//!
//! A snapshot copies a guarded value into Lighthouse memory. An assertion fails the transaction
//! unless the value changed by at least its bound since the snapshot. The bounds come from the
//! postconditions and the rent cap only, not from a simulation, so a program can build them too.
//!
//! Limits, which the planner and `verify_intent` both refuse:
//!
//! 1. A token outflow or inflow is bounded on one token account of the owner. Lighthouse cannot sum
//!    the changes of several, so an owner with two accounts of one mint in the span fails.
//! 2. A token inflow to an owner with no account of the mint must reach the owner's associated
//!    token account, which the span creates.
//! 3. `invokesOnly` has no account state, so no assertion checks it.

#![no_std]

extern crate alloc;

mod assertions;
mod guards;
mod wire;

use core::fmt;

use alloc::vec::Vec;

use sdp_intents_engine::EngineError;
use sdp_intents_spec::Address;

pub use assertions::{Assertions, Guard};
pub use guards::GuardedAccount;
pub use wire::{LighthouseInstruction, Memory, Meta, LIGHTHOUSE_PROGRAM};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuardError {
    Engine(EngineError),
    /// An owner has more than one token account of a bounded mint in the span.
    SeveralAccounts,
    /// No guarded account can receive a bounded inflow.
    NoInflowAccount,
    /// A bound does not fit in the assertion's integer.
    Overflow,
}

impl From<EngineError> for GuardError {
    fn from(error: EngineError) -> Self {
        Self::Engine(error)
    }
}

impl fmt::Display for GuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Engine(error) => write!(f, "{error}"),
            Self::SeveralAccounts => f.write_str("an owner has more than one token account of a bounded mint"),
            Self::NoInflowAccount => f.write_str("no account that the span changes can receive the inflow"),
            Self::Overflow => f.write_str("a bound does not fit in a Lighthouse assertion"),
        }
    }
}

impl core::error::Error for GuardError {}

/// The accounts that the span can change, each once, in the order that the instructions name them:
/// every account that an instruction names writable, and the fee payer, which the runtime makes
/// writable everywhere.
pub fn guarded_addresses(named: impl IntoIterator<Item = Meta>, fee_payer: &Address) -> Vec<Address> {
    let named: Vec<Meta> = named.into_iter().collect();
    let changeable = |address: &Address| {
        address == fee_payer || named.iter().any(|meta| meta.address == *address && meta.role.writable())
    };

    named.iter().map(|meta| meta.address).fold(Vec::new(), |mut addresses, address| {
        if changeable(&address) && !addresses.contains(&address) {
            addresses.push(address);
        }

        addresses
    })
}
