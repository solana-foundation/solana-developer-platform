//! A shielded recipe's spend (`DESIGN.md`, 4.17): whose notes it consumes and which notes it
//! creates. Building and proving the spend needs the spender's shielded keys, the indexer, and the
//! prover, so the caller builds it and returns its instructions. They become the segment's built
//! instructions, which `verify_intent` limits to the pool and Lighthouse bounds by the
//! postconditions, as for a remote recipe.

use sdp_intents_engine::{Chain, Recipe};
use sdp_intents_spec::{Address, ShieldedProtocol};

use crate::plan::Built;
use crate::remote::RemoteAnswer;
use crate::{Instruction, PlanError};

/// A note's asset is the first 32 bytes of its data, and its amount the 8 after.
const AMOUNT_START: usize = 32;
const AMOUNT_END: usize = 40;

/// Where a spend's amounts come from. A writable spender account marks a deposit, because the
/// spend then takes lamports or tokens from the spender's public accounts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShieldedSource {
    /// The spender's unspent notes.
    Notes,
    /// The spender's public balance: a deposit, which needs no proof and is public.
    Public,
}

/// The spend that a shielded segment asks its caller to build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldedCall {
    /// Which protocol's client builds the spend.
    pub protocol: ShieldedProtocol,
    /// The privacy pool program, or the ring program that authorizes the notes.
    pub pool: Address,
    /// The wallet whose notes the spend consumes. It signs and pays.
    pub spender: Address,
    pub source: ShieldedSource,
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

/// The spend that an intent of a shielded recipe requires, as a signer checks it against the notes
/// that it knows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldedSpend {
    pub protocol: ShieldedProtocol,
    pub spender: Address,
    pub source: ShieldedSource,
    pub notes: Vec<ShieldedNote>,
}

pub(crate) fn spend<C: Chain>(recipe: &Recipe<'_>, chain: &C) -> Result<ShieldedSpend, PlanError> {
    let ShieldedCall { protocol, spender, source, notes, .. } = call(recipe, chain, 0)?;

    Ok(ShieldedSpend { protocol, spender, source, notes })
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
    let spender_writable = recipe.implementation().accounts()?.first().is_some_and(|spender| spender.writable());

    let protocol = recipe.implementation().shielded_protocol()?.ok_or(PlanError::ShieldedSpend)?;

    Ok(ShieldedCall {
        protocol,
        pool,
        spender: *recipe.address(0).ok_or(PlanError::Unresolved)?,
        source: if spender_writable { ShieldedSource::Public } else { ShieldedSource::Notes },
        notes,
        fee_payer: *recipe.payers().fee,
        priority_fee_lamports,
    })
}

/// The caller's spend as the segment's built instructions. Each instruction calls the pool, so the
/// spend can move nothing outside it but what the assertions allow.
pub(crate) fn built(recipe: &Recipe<'_>, answer: RemoteAnswer) -> Result<Built, PlanError> {
    let pool = pool(recipe)?;
    let calls_only_the_pool = answer.instructions.iter().all(|instruction| instruction.program == pool);

    if answer.frozen.is_some() || answer.instructions.is_empty() || !calls_only_the_pool {
        return Err(PlanError::ShieldedSpend);
    }

    Built::from_remote(recipe, answer)
}

/// The pool program: the program of the recipe's first note.
fn pool(recipe: &Recipe<'_>) -> Result<Address, PlanError> {
    let first = recipe.implementation().instructions()?.first().ok_or(PlanError::ShieldedNote)?;

    recipe.address(first.program).copied().ok_or(PlanError::Unresolved)
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
