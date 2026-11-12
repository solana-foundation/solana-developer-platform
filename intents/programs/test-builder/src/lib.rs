//! A builder that the tests of the builder library and the planner call. The first round asks for
//! [`EXTRA_ACCOUNT`], as a real builder asks for accounts that depend on data, such as the accounts
//! of a transfer hook. The second round returns a System transfer of `amount` from `from` to `to`.
//! An amount of zero is refused.

use anchor_lang::prelude::*;
use sdp_intents_builder::{Build, Meta};

declare_id!("4nYmBfPS3y66obVLJzRpXZvnj7TjsrLykNj5CWGu4MyS");

/// The account that the first round asks for.
pub const EXTRA_ACCOUNT: Address = Address::from_str_const("DB9QdA21RvPVZzgtB7Pq8n7jDFckv4rc2bRpmegXiQSZ");

const SYSTEM_TRANSFER: u32 = 2;

#[program]
pub mod test_builder {
    use super::*;

    pub fn build_transfer_v1(ctx: &mut Context<BuildTransferV1>, amount: u64) -> Result<()> {
        let remaining = ctx.remaining_accounts();
        let mut build = Build::new(ctx.program_id, <BuildTransferV1 as TryAccounts>::HEADER_SIZE, &remaining)?;

        if amount == 0 {
            return Ok(build.refuse("zeroAmount", "the amount is zero")?);
        }

        let Some(_extra) = build.require_accounts(&[EXTRA_ACCOUNT])? else {
            return Ok(build.finish()?);
        };

        let accounts = [Meta::writable_signer(ctx.accounts.from.address()), Meta::writable(ctx.accounts.to.address())];
        let data = [&SYSTEM_TRANSFER.to_le_bytes()[..], &amount.to_le_bytes()].concat();
        build.instruction(&System::id(), &accounts, &data)?;

        Ok(build.finish()?)
    }
}

#[derive(Accounts)]
pub struct BuildTransferV1 {
    pub from: UncheckedAccount,
    pub to: UncheckedAccount,
}
