//! A shielded recipe's spend (`DESIGN.md`, 4.17): whose notes it consumes and which notes it
//! creates. Building and proving the spend needs the spender's shielded keys, the indexer, and the
//! prover, so the caller builds it. The planner checks the transaction that comes back as it checks
//! a provider's transaction.

use sdp_intents_engine::{Chain, Recipe};
use sdp_intents_spec::Address;

use crate::{Instruction, PlanError};

/// A note's asset is the first 32 bytes of its data, and its amount the 8 after.
const AMOUNT_START: usize = 32;
const AMOUNT_END: usize = 40;

/// The spend that a shielded segment asks its caller to build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldedCall {
    /// The privacy pool program, or the ring program that authorizes the notes.
    pub pool: Address,
    /// The wallet whose notes the spend consumes. It signs and pays.
    pub spender: Address,
    pub notes: Vec<ShieldedNote>,
    pub fee_payer: Address,
    pub priority_fee_lamports: u64,
}

/// A note that the spend creates. The owner is a Solana address, which the registry maps to its
/// shielded address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldedNote {
    pub owner: Address,
    pub asset: Address,
    pub amount: u64,
    pub data: Vec<u8>,
}

/// The engine resolves each note as it resolves a static recipe's instruction.
pub(crate) fn call<C: Chain>(
    recipe: &Recipe<'_>,
    chain: &C,
    priority_fee_lamports: u64,
) -> Result<ShieldedCall, PlanError> {
    let instructions = recipe
        .notes(chain)?
        .map(|built| built.and_then(|built| Instruction::built(&built)))
        .collect::<Result<Vec<_>, _>>()?;
    let pool = instructions.first().map(|note| note.program).ok_or(PlanError::ShieldedNote)?;
    let notes = instructions.iter().map(note).collect::<Result<Vec<_>, _>>()?;

    Ok(ShieldedCall {
        pool,
        spender: *recipe.address(0).ok_or(PlanError::Unresolved)?,
        notes,
        fee_payer: *recipe.payers().fee,
        priority_fee_lamports,
    })
}

fn note(instruction: &Instruction) -> Result<ShieldedNote, PlanError> {
    let [owner] = instruction.accounts.as_slice() else {
        return Err(PlanError::ShieldedNote);
    };
    let asset: [u8; 32] =
        instruction.data.get(..AMOUNT_START).and_then(|bytes| bytes.try_into().ok()).ok_or(PlanError::ShieldedNote)?;
    let amount: [u8; 8] = instruction
        .data
        .get(AMOUNT_START..AMOUNT_END)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(PlanError::ShieldedNote)?;

    Ok(ShieldedNote {
        owner: owner.address,
        asset: Address(asset),
        amount: u64::from_le_bytes(amount),
        data: instruction.data.get(AMOUNT_END..).unwrap_or_default().to_vec(),
    })
}
