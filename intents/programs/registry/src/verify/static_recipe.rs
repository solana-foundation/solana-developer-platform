//! A static recipe: the engine builds the instructions, and each one must equal the sysvar's
//! instruction at its place: the program, each account, and the data, byte for byte. Each account's
//! role must be its role in the transaction, as [`super::roles`] gives it.

use core::ops::Range;

use anchor_lang::prelude::*;
use pinocchio::sysvars::instructions::IntrospectedInstruction;
use sdp_intents_engine::{BuiltInstruction, Chain, Recipe};
use sdp_intents_spec::AccountRole;

use crate::error::RegistryError;
use crate::verify::refused;
use crate::verify::roles::TransactionRoles;

pub fn verify<C: Chain>(
    recipe: &Recipe<'_>,
    chain: &C,
    sysvar: &SysvarInstructions,
    built: Range<usize>,
) -> Result<()> {
    let count = recipe.implementation().instructions().map_err(|error| refused(error.into()))?.len();
    require!(built.len() == count, RegistryError::WrongInstructionCount);

    let roles = transaction_roles(recipe, chain)?;

    recipe.instructions(chain).map_err(refused)?.zip(built).try_for_each(|(expected, position)| {
        let expected = expected.map_err(refused)?;

        compare(&expected, &sysvar.load_instruction_at(position)?, &roles)
    })
}

fn transaction_roles<C: Chain>(recipe: &Recipe<'_>, chain: &C) -> Result<TransactionRoles> {
    let mut roles = TransactionRoles::new(recipe.payers().fee);

    for expected in recipe.instructions(chain).map_err(refused)? {
        for account in expected.map_err(refused)?.accounts() {
            let account = account.map_err(refused)?;
            roles.add(account.address, account.role);
        }
    }

    Ok(roles)
}

fn compare<C: Chain>(
    expected: &BuiltInstruction<'_, C>,
    actual: &IntrospectedInstruction<'_>,
    roles: &TransactionRoles,
) -> Result<()> {
    require!(actual.get_program_id().as_ref() == expected.program.0, RegistryError::WrongInstruction);
    require!(actual.num_account_metas() == expected.accounts_len(), RegistryError::WrongInstruction);

    expected.accounts().enumerate().try_for_each(|(position, account)| {
        let account = account.map_err(refused)?;
        let meta = actual.get_instruction_account_at(position)?;
        let role = AccountRole::new(meta.is_writable(), meta.is_signer());

        require!(meta.key.as_ref() == account.address.0, RegistryError::WrongInstruction);
        require!(role == roles.role(account.address), RegistryError::WrongRole);

        Ok::<(), anchor_lang::Error>(())
    })?;

    let data = actual.get_instruction_data();
    let end = expected.data().try_fold(0usize, |offset, segment| {
        let segment = segment.map_err(refused)?;
        let bytes = segment.as_slice();
        let end = offset.checked_add(bytes.len()).ok_or(ProgramError::ArithmeticOverflow)?;

        require!(data.get(offset..end) == Some(bytes), RegistryError::WrongInstruction);

        Ok::<usize, anchor_lang::Error>(end)
    })?;

    require!(end == data.len(), RegistryError::WrongInstruction);

    Ok(())
}
