//! The builder library. A builder is an instruction that returns the instructions of one operation,
//! in the layouts of `sdp_intents_spec::builder`. The service simulates it, and `verify_intent` calls
//! it by CPI. The library writes the layouts and picks the mode, so a builder author writes only the
//! operation, the same way for both modes:
//!
//! ```
//! use pinocchio::{account::AccountView, address::Address};
//! use sdp_intents_builder::{Build, BuildError, Meta};
//!
//! /// `accounts` are the accounts after the implementation's: in Anchor v2, `ctx.remaining_accounts()`.
//! /// `bumps` is the argument that the implementation passes as `{builder.bumps}`.
//! fn build_transfer(
//!     program_id: &Address,
//!     accounts: &[AccountView],
//!     bumps: &[u8],
//!     owner: &Address,
//!     mint: &Address,
//!     token_program: &Address,
//! ) -> Result<(), BuildError> {
//!     let mut build = Build::new(program_id, 5, accounts, bumps)?;
//!     let owner_account = build.associated_token_address(owner, mint, token_program)?;
//!
//!     let hook_addresses: [Address; 1] = [Address::new_from_array([7; 32])];
//!     let Some(hook_accounts) = build.require_accounts(&hook_addresses)? else {
//!         return build.finish();
//!     };
//!
//!     let metas = [Meta::writable(&owner_account), Meta::writable(hook_accounts[0].address()), Meta::rent_payer()];
//!     build.instruction(token_program, &metas, &[12])?;
//!     build.finish()
//! }
//! ```
//!
//! - In staged mode, a top-level instruction that only a simulation sends, the last account is
//!   scratch. `finish` writes the result there, and a `ResultPointerV1` in return data.
//! - In hashed mode, under CPI, `finish` writes a `HashedReadyV1` in return data: the SHA-256 of the
//!   instruction section, then the outputs.
//! - `require_accounts` returns accounts that the static language cannot derive. In staged mode an
//!   account that the caller did not pass ends the round with `MoreAccounts`, and the service calls
//!   again with it. In hashed mode it is an error, because `verify_intent` passes the last round's.
//! - A builder names the rent payer with [`Meta::rent_payer`]. It never sees a payer, and never
//!   names the fee payer.
//! - [`Build::program_address`] and [`Build::associated_token_address`] derive addresses. In staged
//!   mode each searches for the canonical bump, and the result returns the bumps in order. In
//!   hashed mode each takes the next bump that `verify_intent` passes as `{builder.bumps}`, and
//!   derives with one hash instead of a search. A bump that is missing, not canonical, or left over
//!   fails the builder.

#![no_std]

extern crate alloc;

mod build;
mod error;
mod layout;
mod meta;
#[cfg(not(target_os = "solana"))]
pub mod offchain;
pub mod programs;
pub mod token;

pub use build::Build;
pub use error::BuildError;
pub use meta::{Meta, RENT_PAYER};
