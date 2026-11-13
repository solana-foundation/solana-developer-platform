//! Turns an intent and its records into instructions. The service and the registry program run the
//! same code.
//!
//! The engine reads the views of `sdp-intents-spec`. It allocates nothing and never fetches an
//! account. The caller holds the accounts behind [`Chain`]:
//!
//! 1. [`Recipe::parse`] checks that the intent fits the interface and the implementation.
//! 2. [`Recipe::resolve`] derives each account address and checks the owner hints. It returns
//!    [`Resolution::Missing`] with every account whose data the next step needs. The service fetches
//!    those in one call and resolves again, once for each `hasOne` level.
//! 3. [`Recipe::instructions`] yields the instructions of a static recipe. [`Recipe::builder_call`]
//!    gives the call of a program recipe, with the accounts that the builder asked for in earlier
//!    rounds. The data borrows from the documents and the chain.
//!
//! ```
//! use sdp_intents_engine::{Chain, EngineError, Payers, Recipe, Resolution};
//! use sdp_intents_spec::Address;
//!
//! /// The service's account cache. `fetch` loads accounts with one `getMultipleAccounts`.
//! trait Cache: Chain {
//!     fn fetch<'a>(&mut self, addresses: impl Iterator<Item = &'a Address>);
//! }
//!
//! fn build(documents: [&[u8]; 3], payers: Payers<'_>, cache: &mut impl Cache) -> Result<(), EngineError> {
//!     let [interface, implementation, intent] = documents;
//!     let mut recipe = Recipe::parse(interface, implementation, intent, payers)?;
//!
//!     while let Resolution::Missing(missing) = recipe.resolve(&*cache)? {
//!         cache.fetch(missing.addresses());
//!     }
//!
//!     for instruction in recipe.instructions(&*cache)? {
//!         let instruction = instruction?;
//!         // instruction.program, instruction.accounts(), and instruction.data()
//!     }
//!
//!     Ok(())
//! }
//! ```
//!
//! A program backs [`Chain`] with the accounts of its instruction, so one `resolve` completes or
//! fails. It then compares each resolved address with the account at that place, and each built
//! instruction with the instructions sysvar.

#![cfg_attr(not(test), no_std)]

mod borsh;
mod chain;
mod documents;
mod error;
mod hints;
mod instructions;
mod payers;
mod pda;
mod recipe;
mod resolve;
mod value;

#[cfg(test)]
mod test_support;

pub use chain::{AccountData, Chain};
pub use error::EngineError;
pub use instructions::{BuiltAccount, BuiltInstruction, Instructions};
pub use payers::Payers;
pub use recipe::{Missing, Recipe, Resolution};
pub use value::Bytes;
