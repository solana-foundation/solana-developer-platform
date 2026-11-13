//! Where the instructions are that `verify_intent` checks.
//!
//! `verify_intent` is a top-level instruction. Every instruction before it is a ComputeBudget
//! instruction, and every instruction after it is a built instruction. So `verify_intent` checks
//! the whole transaction, and a signer finds the intent at one place. It runs before the built
//! instructions, so a builder that it calls reads the state that the simulation read, not the
//! state after the built instructions. A transaction therefore holds one intent.

use core::ops::Range;

use anchor_lang::prelude::*;
use solana_instruction::syscalls::get_stack_height;

use crate::error::RegistryError;

const COMPUTE_BUDGET_PROGRAM: Address = Address::from_str_const("ComputeBudget111111111111111111111111111111");
const TRANSACTION_LEVEL_STACK_HEIGHT: usize = 1;

/// The positions of the built instructions in the instructions sysvar.
pub fn built_instructions(sysvar: &SysvarInstructions) -> Result<Range<usize>> {
    require!(get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT, RegistryError::NotTopLevel);

    let current = usize::from(sysvar.load_current_index());
    let program = sysvar.load_instruction_at(current)?;
    require!(*program.get_program_id() == crate::ID, RegistryError::NotTopLevel);

    let only_budget_before = (0..current).all(|position| {
        sysvar
            .load_instruction_at(position)
            .is_ok_and(|instruction| *instruction.get_program_id() == COMPUTE_BUDGET_PROGRAM)
    });

    require!(only_budget_before, RegistryError::UnverifiedInstruction);

    let first = current.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;

    Ok(first..sysvar.num_instructions())
}
