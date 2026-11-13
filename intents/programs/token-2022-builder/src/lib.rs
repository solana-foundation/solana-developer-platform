//! The builder of `solana.org/token-2022-transfer`. `build_transfer_v1` returns a Token-2022
//! `transferChecked` from the ATA of `from` to the ATA of `to`, with what the mint's extensions need:
//!
//! - The destination ATA, when it does not exist. The rent payer funds it.
//! - A memo before the transfer, when the intent has one. A destination that requires memos and an
//!   intent without one is refused.
//! - The accounts of the transfer hook. They can need `MoreAccounts` rounds (see [`hook`]).
//! - A refusal for each transfer that Token-2022 fails or that SDP does not support (see
//!   [`Refusal`]).
//!
//! A transfer fee needs nothing more. `transferChecked` moves `amount` out of the source, and the
//! destination receives `amount` less the fee, which Token-2022 withholds in the destination.

use anchor_lang::prelude::*;
use sdp_intents_builder::Build;

extern crate alloc;

mod extra_metas;
pub mod hook;
mod preconditions;
mod refusal;
pub mod token_data;
mod transfer;

pub use refusal::Refusal;

use crate::preconditions::TransferAccounts;
use crate::refusal::Stop;

declare_id!("2gMFoKF3p5eB2m72ccjncZH8e5agVYbHBH8A29zDMdBm");

#[program]
pub mod token_2022_builder {
    use super::*;

    pub fn build_transfer_v1(
        ctx: &mut Context<BuildTransferV1>,
        amount: u64,
        memo: Option<String>,
        bumps: &[u8],
    ) -> Result<()> {
        let remaining = ctx.remaining_accounts();
        let mut build = Build::new(ctx.program_id, <BuildTransferV1 as TryAccounts>::HEADER_SIZE, &remaining, bumps)?;
        let accounts = TransferAccounts {
            mint: ctx.accounts.mint.account(),
            from: ctx.accounts.from.account(),
            to: ctx.accounts.to.account(),
            source: ctx.accounts.source.account(),
            destination: ctx.accounts.destination.account(),
        };

        match transfer::build_transfer(&mut build, &accounts, amount, memo.as_deref()) {
            Ok(()) => Ok(build.finish()?),
            Err(Stop::Refused(refusal)) => Ok(build.refuse(refusal.code(), refusal.message())?),
            Err(Stop::Failed(error)) => Err(error),
        }
    }
}

/// The implementation's accounts, all readonly. The ATAs are those of Token-2022.
#[derive(Accounts)]
pub struct BuildTransferV1 {
    pub mint: UncheckedAccount,
    pub from: UncheckedAccount,
    pub to: UncheckedAccount,
    pub source: UncheckedAccount,
    pub destination: UncheckedAccount,
}
