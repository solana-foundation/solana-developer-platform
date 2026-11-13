//! Where the instructions are that `verify_intent` checks.
//!
//! `verify_intent` is a top-level instruction, and its span is the instructions right after it. The
//! span's length comes from the record or the builder, never from the transaction. So a signer finds
//! each intent's instructions from the `verify_intent` instructions alone. Instructions outside every
//! span are unverified, and the signer reads them as they are.
//!
//! `verify_intent` runs before its span, so a builder that it calls reads the state that the
//! simulation read: the state after the instructions before `verify_intent`.

use core::ops::Range;

use anchor_lang::prelude::*;
use solana_instruction::syscalls::get_stack_height;

use crate::error::RegistryError;

const TRANSACTION_LEVEL_STACK_HEIGHT: usize = 1;

/// Fails unless `verify_intent` runs as a top-level instruction.
pub fn check_top_level(sysvar: &SysvarInstructions) -> Result<()> {
    require!(get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT, RegistryError::NotTopLevel);

    let program = sysvar.load_instruction_at(usize::from(sysvar.load_current_index()))?;
    require!(*program.get_program_id() == crate::ID, RegistryError::NotTopLevel);

    Ok(())
}

/// The positions of the `len` instructions after `verify_intent`. A registry instruction in the
/// span would put one intent's instructions inside another's, so it fails.
pub fn span(sysvar: &SysvarInstructions, len: usize) -> Result<Range<usize>> {
    let first = usize::from(sysvar.load_current_index()).checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
    let end = first.checked_add(len).ok_or(ProgramError::ArithmeticOverflow)?;
    require!(end <= sysvar.num_instructions(), RegistryError::SpanPastEnd);

    let registry_inside = (first..end).any(|position| {
        sysvar.load_instruction_at(position).is_ok_and(|instruction| *instruction.get_program_id() == crate::ID)
    });

    require!(!registry_inside, RegistryError::RegistryInstructionInSpan);

    Ok(first..end)
}

/// True when an instruction outside `span` names `address`. `verify_intent` instructions do not
/// count, because each one names its record's accounts readonly.
pub fn named_outside(sysvar: &SysvarInstructions, span: &Range<usize>, address: &Address) -> bool {
    (0..sysvar.num_instructions()).filter(|position| !span.contains(position)).any(|position| {
        sysvar.load_instruction_at(position).is_ok_and(|instruction| {
            *instruction.get_program_id() != crate::ID
                && (0..instruction.num_account_metas()).any(|account| {
                    instruction.get_instruction_account_at(account).is_ok_and(|meta| meta.key == *address)
                })
        })
    })
}
