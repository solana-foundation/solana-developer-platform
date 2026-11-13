//! A remote recipe: no builder can rebuild its instructions, so `verify_intent` checks what holds
//! for any instructions. Each built program is one that every `invokesOnly` of the implementation lists.
//! Each output that the implementation binds is the implementation's. Each account's role in the transaction is the
//! union of the roles that the planner states. The assertions then follow from the postconditions,
//! as for any recipe.

use core::ops::Range;

use anchor_lang::prelude::*;
use sdp_intents_engine::Recipe;
use sdp_intents_spec::CheckKind;

use crate::error::RegistryError;
use crate::state::spec_address;
use crate::verify::refused;

/// An output is one address of 32 bytes.
const OUTPUT_LEN: usize = 32;

/// Each output that the implementation binds must be the implementation's, and every output must be present.
pub fn check_outputs(recipe: &Recipe<'_>, outputs: &[u8]) -> Result<()> {
    let count = recipe.interface().outputs().map_err(|error| refused(error.into()))?.len();
    let (chunks, rest) = outputs.as_chunks::<OUTPUT_LEN>();
    require!(chunks.len() == count && rest.is_empty(), RegistryError::WrongOutputs);

    let bound_differs = (0u8..)
        .zip(chunks)
        .any(|(output, address)| recipe.output_address(output).is_ok_and(|bound| bound.0 != *address));
    require!(!bound_differs, RegistryError::WrongOutputs);

    Ok(())
}

/// Each instruction of the built span calls a program that every `invokesOnly` of the implementation lists.
pub fn check_programs(recipe: &Recipe<'_>, sysvar: &SysvarInstructions, built: &Range<usize>) -> Result<()> {
    let implementation = recipe.implementation();
    let spec = |error: sdp_intents_spec::SpecError| refused(error.into());
    let addresses = implementation.addresses().map_err(spec)?;
    let lists = implementation
        .post_conditions()
        .map_err(spec)?
        .iter()
        .filter(|condition| condition.check == u8::from(CheckKind::InvokesOnly))
        .map(|condition| {
            let first = usize::from(condition.programs.first);
            let end = first.checked_add(usize::from(condition.programs.count)).ok_or(RegistryError::BadDocument)?;

            addresses.get(first..end).ok_or_else(|| RegistryError::BadDocument.into())
        })
        .collect::<Result<alloc::vec::Vec<_>>>()?;
    require!(!lists.is_empty(), RegistryError::ProgramNotListed);

    for position in built.clone() {
        let program = spec_address(sysvar.load_instruction_at(position)?.get_program_id());
        require!(lists.iter().all(|list| list.contains(&program)), RegistryError::ProgramNotListed);
    }

    Ok(())
}
