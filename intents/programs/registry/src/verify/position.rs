//! Where the instructions are that `verify_intent` checks.
//!
//! `verify_intent` is a top-level instruction, and its segment is the instructions right after it:
//! the Lighthouse snapshots, the built instructions, then the Lighthouse assertions. The counts come
//! from the record, the builder, and the postconditions, never from the transaction. So a signer
//! finds each intent's instructions from the `verify_intent` instructions alone. Instructions outside
//! every segment are unverified, and the signer reads them as they are.
//!
//! `verify_intent` runs before its segment, so a builder that it calls reads the state that the
//! simulation read: the state after the instructions before `verify_intent`.

use core::ops::Range;

use anchor_lang::prelude::*;
use solana_instruction::syscalls::get_stack_height;

use crate::error::RegistryError;
use crate::state::spec_address;

const TRANSACTION_LEVEL_STACK_HEIGHT: usize = 1;

/// The span of the built instructions, and the whole segment around it.
pub struct Segment {
    pub built: Range<usize>,
    pub whole: Range<usize>,
}

/// Fails unless `verify_intent` runs as a top-level instruction.
pub fn check_top_level(sysvar: &SysvarInstructions) -> Result<()> {
    require!(get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT, RegistryError::NotTopLevel);

    let program = sysvar.load_instruction_at(current(sysvar))?;
    require!(*program.get_program_id() == crate::ID, RegistryError::NotTopLevel);

    Ok(())
}

/// The position after `verify_intent`.
pub fn first_after(sysvar: &SysvarInstructions) -> Result<usize> {
    current(sysvar).checked_add(1).ok_or(ProgramError::ArithmeticOverflow)
}

/// The Lighthouse instructions from `first` on: the snapshots of the segment. A built instruction
/// that invokes Lighthouse first would count too, and the compare then fails.
pub fn lighthouse_run(sysvar: &SysvarInstructions, first: usize) -> usize {
    let lighthouse = Address::new_from_array(sdp_intents_lighthouse::LIGHTHOUSE_PROGRAM.0);

    (first..sysvar.num_instructions())
        .take_while(|position| {
            sysvar.load_instruction_at(*position).is_ok_and(|instruction| *instruction.get_program_id() == lighthouse)
        })
        .count()
}

/// The positions of `len` instructions from `first`. A registry instruction among them would put
/// one intent's instructions inside another's segment, so it fails.
pub fn span(sysvar: &SysvarInstructions, first: usize, len: usize) -> Result<Range<usize>> {
    let end = first.checked_add(len).ok_or(ProgramError::ArithmeticOverflow)?;
    require!(end <= sysvar.num_instructions(), RegistryError::SpanPastEnd);

    let registry_inside = (first..end).any(|position| {
        sysvar.load_instruction_at(position).is_ok_and(|instruction| *instruction.get_program_id() == crate::ID)
    });

    require!(!registry_inside, RegistryError::RegistryInstructionInSpan);

    Ok(first..end)
}

/// True when an instruction outside `segment` names `address`. `verify_intent` instructions do not
/// count, because each one names its record's accounts readonly.
pub fn named_outside(sysvar: &SysvarInstructions, segment: &Range<usize>, address: &Address) -> bool {
    (0..sysvar.num_instructions()).filter(|position| !segment.contains(position)).any(|position| {
        sysvar.load_instruction_at(position).is_ok_and(|instruction| {
            *instruction.get_program_id() != crate::ID
                && (0..instruction.num_account_metas()).any(|account| {
                    instruction.get_instruction_account_at(account).is_ok_and(|meta| meta.key == *address)
                })
        })
    })
}

/// Each account of the instructions in `range` with the role that `roles` gives it, in order.
/// `roles` holds one role for each account.
pub fn named(
    sysvar: &SysvarInstructions,
    range: &Range<usize>,
    mut roles: impl Iterator<Item = sdp_intents_spec::AccountRole>,
) -> Result<alloc::vec::Vec<sdp_intents_lighthouse::Meta>> {
    let mut named = alloc::vec::Vec::new();

    for position in range.clone() {
        let instruction = sysvar.load_instruction_at(position)?;

        for account in 0..instruction.num_account_metas() {
            let address = spec_address(&instruction.get_instruction_account_at(account)?.key);
            let role = roles.next().ok_or(RegistryError::WrongBuilderRoles)?;

            named.push(sdp_intents_lighthouse::Meta { address, role });
        }
    }

    Ok(named)
}

fn current(sysvar: &SysvarInstructions) -> usize {
    usize::from(sysvar.load_current_index())
}
