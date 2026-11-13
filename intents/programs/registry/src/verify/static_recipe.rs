//! A static recipe: the engine builds the instructions, and each one must equal the sysvar's
//! instruction at its place, byte for byte. The sysvar holds each account's role in the
//! transaction, so an account that another instruction makes writable or a signer differs from a
//! record that declares it readonly.

use core::ops::Range;

use anchor_lang::prelude::*;
use pinocchio::sysvars::instructions::IntrospectedInstruction;
use sdp_intents_engine::{BuiltInstruction, Chain, Recipe};
use sdp_intents_spec::AccountRole;

use crate::error::RegistryError;
use crate::verify::refused;

pub fn verify<C: Chain>(
    recipe: &Recipe<'_>,
    chain: &C,
    sysvar: &SysvarInstructions,
    built: Range<usize>,
) -> Result<()> {
    let count = recipe.implementation().instructions().map_err(|error| refused(error.into()))?.len();
    require!(built.len() == count, RegistryError::WrongInstructionCount);

    recipe.instructions(chain).map_err(refused)?.zip(built).try_for_each(|(expected, position)| {
        let expected = expected.map_err(refused)?;

        compare(&expected, &sysvar.load_instruction_at(position)?)
    })
}

fn compare<C: Chain>(expected: &BuiltInstruction<'_, C>, actual: &IntrospectedInstruction<'_>) -> Result<()> {
    require!(actual.get_program_id().as_ref() == expected.program.0, RegistryError::WrongInstruction);
    require!(actual.num_account_metas() == expected.accounts_len(), RegistryError::WrongInstruction);

    expected.accounts().enumerate().try_for_each(|(position, account)| {
        let account = account.map_err(refused)?;
        let meta = actual.get_instruction_account_at(position)?;
        let role = AccountRole::new(meta.is_writable(), meta.is_signer());

        require!(meta.key.as_ref() == account.address.0 && role == account.role, RegistryError::WrongInstruction);

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
