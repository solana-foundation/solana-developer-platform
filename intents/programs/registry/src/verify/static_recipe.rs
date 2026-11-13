//! A static recipe: the engine builds the instructions, and each one must equal the sysvar's
//! instruction at its place in the span: the program, each account, and the data, byte for byte.
//! Each account's role must be its role in the transaction, as [`super::roles`] gives it.

use alloc::vec::Vec;
use core::ops::Range;

use anchor_lang::prelude::*;
use pinocchio::sysvars::instructions::IntrospectedInstruction;
use sdp_intents_engine::{BuiltInstruction, Chain, Recipe};
use sdp_intents_lighthouse::Meta;
use sdp_intents_spec::AccountRole;

use crate::error::RegistryError;
use crate::verify::position::Segment;
use crate::verify::refused;
use crate::verify::roles::TransactionRoles;

/// The number of instructions that the recipe builds.
pub fn count(recipe: &Recipe<'_>) -> Result<usize> {
    Ok(recipe.implementation().instructions().map_err(|error| refused(error.into()))?.len())
}

/// The output addresses that the implementation binds, in borsh.
pub fn outputs(recipe: &Recipe<'_>) -> Result<Vec<u8>> {
    let count = recipe.interface().outputs().map_err(|error| refused(error.into()))?.len();

    (0u8..)
        .take(count)
        .map(|output| recipe.output_address(output).map(|address| address.0).map_err(refused))
        .collect::<Result<Vec<_>>>()
        .map(|addresses| addresses.concat())
}

/// What the comparison of the built span found: each account of the built instructions with its
/// role, in order, and the union of each account's roles, which [`check_roles`] needs.
pub struct Compared {
    pub named: Vec<Meta>,
    roles: TransactionRoles,
}

/// Builds the implementation's instructions once, and compares each with the sysvar's instruction at its
/// place in `built`: the program, each account's address, and the data, byte for byte.
pub fn compare<C: Chain>(
    recipe: &Recipe<'_>,
    chain: &C,
    sysvar: &SysvarInstructions,
    built: &Range<usize>,
) -> Result<Compared> {
    let mut compared = Compared { named: Vec::new(), roles: TransactionRoles::new(recipe.payers().fee) };

    recipe.instructions(chain).map_err(refused)?.zip(built.clone()).try_for_each(|(expected, position)| {
        compared.add(&expected.map_err(refused)?, &sysvar.load_instruction_at(position)?)
    })?;

    Ok(compared)
}

/// Each account's role in the sysvar must be the union of its roles in the span, or a role that an
/// instruction outside the segment explains.
pub fn check_roles(compared: &Compared, sysvar: &SysvarInstructions, segment: &Segment) -> Result<()> {
    segment.built.clone().try_for_each(|position| {
        let actual = sysvar.load_instruction_at(position)?;

        (0..actual.num_account_metas()).try_for_each(|index| {
            let meta = actual.get_instruction_account_at(index)?;
            let role = AccountRole::new(meta.is_writable(), meta.is_signer());

            compared.roles.check(sysvar, &segment.whole, &meta.key, role)
        })
    })
}

impl Compared {
    fn add<C: Chain>(
        &mut self,
        expected: &BuiltInstruction<'_, C>,
        actual: &IntrospectedInstruction<'_>,
    ) -> Result<()> {
        require!(actual.get_program_id().as_ref() == expected.program.0, RegistryError::WrongInstruction);
        require!(actual.num_account_metas() == expected.accounts_len(), RegistryError::WrongInstruction);

        expected.accounts().enumerate().try_for_each(|(position, account)| {
            let account = account.map_err(refused)?;
            let meta = actual.get_instruction_account_at(position)?;
            require!(meta.key.as_ref() == account.address.0, RegistryError::WrongInstruction);

            self.named.push(Meta { address: *account.address, role: account.role });
            self.roles.add(account.address, account.role);

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
}
