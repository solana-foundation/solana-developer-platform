//! A shielded recipe's statement (`DESIGN.md`, 4.17): the notes that the spend creates, and the
//! public amounts that it deposits and withdraws. What it consumes follows from conservation.
//! Building and proving the spend needs the spender's shielded keys, so the caller builds it and
//! returns its instructions. They become the segment's built instructions, which `verify_intent`
//! limits to the pool and Lighthouse bounds by the postconditions, as for a remote recipe.

use sdp_intents_engine::{Chain, Recipe};
use sdp_intents_spec::wire::{DocumentIdV1, DocumentKind};
use sdp_intents_spec::{Address, Circuit, ShieldedEntry, ShieldedProtocol};

use crate::plan::Built;
use crate::registry::{version_address, REGISTRY_PROGRAM, VERSION_HEADER_LEN};
use crate::remote::RemoteAnswer;
use crate::{Instruction, PlanError};

/// An entry's asset is the first 32 bytes of its data, and its amount the 8 after.
const AMOUNT_START: usize = 32;
const AMOUNT_END: usize = 40;

/// The spend that a shielded segment asks its caller to build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldedCall {
    /// The privacy pool program, or the ring program that authorizes the notes.
    pub pool: Address,
    pub spend: ShieldedSpend,
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

/// A public amount that the spend deposits from `account` or withdraws to it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldedLeg {
    pub account: Address,
    pub asset: Address,
    pub amount: u64,
}

/// The statement that an intent of a shielded recipe requires. The spender's wallet builds a spend
/// from it, and signs only a spend that it built from the statement that the verifier reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldedSpend {
    /// Which protocol's client builds the spend.
    pub protocol: ShieldedProtocol,
    /// The circuit that the spender proves with, as the registry holds it.
    pub circuit: ShieldedCircuit,
    /// The wallet whose notes the spend consumes. It signs.
    pub spender: Address,
    pub notes: Vec<ShieldedNote>,
    pub deposits: Vec<ShieldedLeg>,
    pub withdrawals: Vec<ShieldedLeg>,
}

/// A circuit document at its exact version. The spender's client refuses proving keys that it does
/// not hold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldedCircuit {
    pub id: DocumentIdV1,
    /// The name that the id hashes, such as `privacy-rings-transact`.
    pub name: String,
    pub proving_keys: [u8; 32],
}

/// The version account of the recipe's circuit, which the planner and the verifier read.
pub(crate) fn circuit_address(recipe: &Recipe<'_>) -> Result<Address, PlanError> {
    let doc = recipe.implementation().shielded()?.ok_or(PlanError::ShieldedSpend)?;

    version_address(DocumentKind::Circuit, &doc.circuit.id)
}

/// The recipe's circuit from its version account. It must be the named version, of the recipe's
/// protocol.
fn circuit<C: Chain>(recipe: &Recipe<'_>, chain: &C, protocol: ShieldedProtocol) -> Result<ShieldedCircuit, PlanError> {
    let implementation = recipe.implementation();
    let named = implementation.shielded()?.ok_or(PlanError::ShieldedSpend)?.circuit;
    let account = chain.account(&circuit_address(recipe)?).ok_or(PlanError::Unresolved)?;
    let document = account
        .data
        .get(VERSION_HEADER_LEN..)
        .filter(|_| *account.owner == REGISTRY_PROGRAM)
        .ok_or(PlanError::ShieldedCircuit)?;
    let circuit = Circuit::parse(document).map_err(|_| PlanError::ShieldedCircuit)?;

    if *circuit.id() != named.id || circuit.protocol()? != protocol {
        return Err(PlanError::ShieldedCircuit);
    }

    let name = core::str::from_utf8(implementation.text(named.name)?).map_err(|_| PlanError::ShieldedCircuit)?;

    Ok(ShieldedCircuit { id: named.id, name: name.to_owned(), proving_keys: *circuit.proving_keys() })
}

pub(crate) fn spend<C: Chain>(recipe: &Recipe<'_>, chain: &C) -> Result<ShieldedSpend, PlanError> {
    call(recipe, chain, 0).map(|call| call.spend)
}

/// The engine resolves each entry as it resolves a static recipe's instruction.
pub(crate) fn call<C: Chain>(
    recipe: &Recipe<'_>,
    chain: &C,
    priority_fee_lamports: u64,
) -> Result<ShieldedCall, PlanError> {
    let implementation = recipe.implementation();
    let doc = implementation.shielded()?.ok_or(PlanError::ShieldedSpend)?;
    let instructions = recipe
        .notes(chain)?
        .map(|built| built.and_then(|built| Instruction::built(&built)))
        .collect::<Result<Vec<_>, _>>()?;
    let pool = instructions.first().map(|entry| entry.program).ok_or(PlanError::ShieldedNote)?;

    let protocol = ShieldedProtocol::try_from(doc.protocol)?;
    let mut spend = ShieldedSpend {
        protocol,
        circuit: circuit(recipe, chain, protocol)?,
        spender: *recipe.address(0).ok_or(PlanError::Unresolved)?,
        notes: Vec::new(),
        deposits: Vec::new(),
        withdrawals: Vec::new(),
    };

    for (index, instruction) in instructions.iter().enumerate() {
        let entry = Entry::read(instruction)?;

        match implementation.shielded_entry(index)?.ok_or(PlanError::ShieldedNote)? {
            ShieldedEntry::Note => spend.notes.push(entry.note()),
            ShieldedEntry::Deposit => spend.deposits.push(entry.leg()?),
            ShieldedEntry::Withdrawal => spend.withdrawals.push(entry.leg()?),
        }
    }

    Ok(ShieldedCall { pool, spend, fee_payer: *recipe.payers().fee, priority_fee_lamports })
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

/// One entry of the statement, as the engine resolved it.
struct Entry {
    account: Address,
    asset: Address,
    amount: u64,
    data: Vec<u8>,
}

impl Entry {
    fn read(instruction: &Instruction) -> Result<Self, PlanError> {
        let [account] = instruction.accounts.as_slice() else {
            return Err(PlanError::ShieldedNote);
        };
        let asset: [u8; 32] = instruction
            .data
            .get(..AMOUNT_START)
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or(PlanError::ShieldedNote)?;
        let amount: [u8; 8] = instruction
            .data
            .get(AMOUNT_START..AMOUNT_END)
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or(PlanError::ShieldedNote)?;

        Ok(Self {
            account: account.address,
            asset: Address(asset),
            amount: u64::from_le_bytes(amount),
            data: instruction.data.get(AMOUNT_END..).unwrap_or_default().to_vec(),
        })
    }

    fn note(self) -> ShieldedNote {
        ShieldedNote { owner: self.account, asset: self.asset, amount: self.amount, data: self.data }
    }

    /// A deposit or a withdrawal carries no data.
    fn leg(self) -> Result<ShieldedLeg, PlanError> {
        if !self.data.is_empty() {
            return Err(PlanError::ShieldedNote);
        }

        Ok(ShieldedLeg { account: self.account, asset: self.asset, amount: self.amount })
    }
}
