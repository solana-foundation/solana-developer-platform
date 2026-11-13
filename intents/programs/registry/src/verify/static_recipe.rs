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

/// Each account of the built instructions with its role, in order.
pub fn named<C: Chain>(recipe: &Recipe<'_>, chain: &C) -> Result<Vec<Meta>> {
    let mut named = Vec::new();

    for expected in recipe.instructions(chain).map_err(refused)? {
        for account in expected.map_err(refused)?.accounts() {
            let account = account.map_err(refused)?;
            named.push(Meta { address: *account.address, role: account.role });
        }
    }

    Ok(named)
}

/// The output addresses that the record binds, in borsh.
pub fn outputs(recipe: &Recipe<'_>) -> Result<Vec<u8>> {
    let count = recipe.interface().outputs().map_err(|error| refused(error.into()))?.len();

    (0u8..)
        .take(count)
        .map(|output| recipe.output_address(output).map(|address| address.0).map_err(refused))
        .collect::<Result<Vec<_>>>()
        .map(|addresses| addresses.concat())
}

pub fn verify<C: Chain>(recipe: &Recipe<'_>, chain: &C, sysvar: &SysvarInstructions, segment: &Segment) -> Result<()> {
    let roles = transaction_roles(recipe, chain)?;
    let checked = Checked { sysvar, span: &segment.whole, roles: &roles };

    recipe.instructions(chain).map_err(refused)?.zip(segment.built.clone()).try_for_each(|(expected, position)| {
        let expected = expected.map_err(refused)?;

        checked.compare(&expected, &sysvar.load_instruction_at(position)?)
    })
}

/// What each instruction of the span is compared against.
struct Checked<'a> {
    sysvar: &'a SysvarInstructions,
    span: &'a Range<usize>,
    roles: &'a TransactionRoles,
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

impl Checked<'_> {
    fn compare<C: Chain>(
        &self,
        expected: &BuiltInstruction<'_, C>,
        actual: &IntrospectedInstruction<'_>,
    ) -> Result<()> {
        require!(actual.get_program_id().as_ref() == expected.program.0, RegistryError::WrongInstruction);
        require!(actual.num_account_metas() == expected.accounts_len(), RegistryError::WrongInstruction);

        expected.accounts().enumerate().try_for_each(|(position, account)| {
            let account = account.map_err(refused)?;
            let meta = actual.get_instruction_account_at(position)?;
            let role = AccountRole::new(meta.is_writable(), meta.is_signer());

            require!(meta.key.as_ref() == account.address.0, RegistryError::WrongInstruction);

            self.roles.check(self.sysvar, self.span, &meta.key, role)
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
