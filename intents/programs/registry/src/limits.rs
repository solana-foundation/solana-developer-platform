//! The limits of DESIGN.md 4.9 that `publish` checks, beyond what `parse` checks. The values are
//! those of `compiler/src/limits.rs`, which must change with them. The 10,000-byte document limit
//! bounds the seed, segment, and pool tables, which the views do not expose whole.

use anchor_lang::prelude::*;
use sdp_intents_spec::{Implementation, Interface, SpecError};

use crate::error::RegistryError;

const TEMPLATE_BYTES: usize = 256;
const INPUTS: usize = 16;
const OUTPUTS: usize = 8;
const POST_CONDITIONS: usize = 8;
const LITERALS: usize = 16;
const APPLIES: usize = 4;
const ADDRESSES: usize = 32;
const ACCOUNTS: usize = 32;
const INSTRUCTIONS: usize = 12;

pub fn check_interface(interface: &Interface<'_>) -> Result<()> {
    let counts = [
        (interface.display().map(<[u8]>::len), TEMPLATE_BYTES),
        (interface.inputs().map(<[_]>::len), INPUTS),
        (interface.outputs().map(<[_]>::len), OUTPUTS),
        (interface.post_conditions().map(<[_]>::len), POST_CONDITIONS),
        (interface.literals().map(<[_]>::len), LITERALS),
        (interface.addresses().map(<[_]>::len), ADDRESSES),
    ];

    within(&counts)
}

pub fn check_implementation(implementation: &Implementation<'_>) -> Result<()> {
    let counts = [
        (implementation.message().map(<[u8]>::len), TEMPLATE_BYTES),
        (implementation.applies().map(<[_]>::len), APPLIES),
        (implementation.post_conditions().map(<[_]>::len), POST_CONDITIONS),
        (implementation.literals().map(<[_]>::len), LITERALS),
        (implementation.addresses().map(<[_]>::len), ADDRESSES),
        (implementation.accounts().map(<[_]>::len), ACCOUNTS),
        (implementation.instructions().map(<[_]>::len), INSTRUCTIONS),
    ];

    within(&counts)
}

fn within(counts: &[(core::result::Result<usize, SpecError>, usize)]) -> Result<()> {
    let holds = counts.iter().all(|(count, limit)| count.as_ref().is_ok_and(|count| count <= limit));

    require!(holds, RegistryError::BadDocument);

    Ok(())
}
