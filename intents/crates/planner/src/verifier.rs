//! Verifies a transaction offchain, as a signer does before it signs. It renders the plan message
//! from what the transaction proves, finds each intent's segment, and lists every instruction that no
//! segment holds. A signer compares the message with the one it signs, and shows each listed
//! instruction as it is.
//!
//! It reads each segment from its `verify_intent`: the intent, the outputs, the payers, the rent
//! cap, and the counts. `verify_intent` refuses values that differ from what it derives, so a
//! transaction that lands holds what the verifier read. It reads the documents from the registry's
//! version accounts, never from the service. Like the planner, it does no IO: each call returns the
//! accounts that it needs next, or the result.

use core::ops::Range;

use sdp_intents_engine::{Chain, Payers, Recipe, Resolution};
use sdp_intents_spec::wire::DocumentKind;
use sdp_intents_spec::{Address, Intent};

use crate::plan::{plan_message, with_rent_cap};
use crate::registry::{verify_intent_discriminator, version_address, REGISTRY_PROGRAM};
use crate::values::Values;
use crate::{Instruction, PlanError, Transaction};

/// A version account holds the 8-byte discriminator, the version, and the publish slot, then the
/// document.
const VERSION_HEADER_LEN: usize = 8 + 6 + 8;
/// `verify_intent` names the fee payer, the rent payer, the two indexes, then the interface version
/// and the implementation version, after the sysvar.
const FEE_PAYER: usize = 1;
const RENT_PAYER: usize = 2;
const INTERFACE_VERSION: usize = 5;
const IMPLEMENTATION_VERSION: usize = 6;

/// What the verifier needs next.
#[derive(Debug)]
pub enum VerifyStep {
    /// Fetch these accounts, then call [`verify_transaction`] again.
    Fetch(Vec<Address>),
    Done(Box<VerifiedTransaction>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedTransaction {
    /// The plan message as the transaction proves it: the payers, the priority fee, and each intent
    /// that has a `verify_intent`. An intent with no `verify_intent` is not in it, so a plan with one
    /// has a message that differs.
    pub message: String,
    pub intents: Vec<VerifiedIntent>,
    /// The positions of the instructions that no segment holds, other than ComputeBudget
    /// instructions.
    pub unverified: Vec<usize>,
}

/// Where one intent's segment is in the transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedIntent {
    pub verify: usize,
    /// The instructions that the record built.
    pub built: Range<usize>,
    /// `verify_intent` and every instruction after it that the segment holds.
    pub segment: Range<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VerifyError {
    Plan(PlanError),
    /// The `verify_intent` at this position has data or accounts that do not decode.
    BadVerifyIntent(usize),
    /// The segment of the `verify_intent` at this position ends past the transaction, or holds
    /// another `verify_intent`.
    BadSegment(usize),
    /// The `verify_intent` at this position states a bump that is not the canonical bump of a
    /// program address of its record.
    NonCanonicalBump(usize),
    /// A `verify_intent` names another fee payer than the transaction's.
    WrongFeePayer(usize),
    /// The `verify_intent` instructions name different rent payers.
    PayersDiffer,
    /// The account is not the registry's version account of the document that the intent names.
    NotAVersion(Address),
}

impl From<PlanError> for VerifyError {
    fn from(error: PlanError) -> Self {
        Self::Plan(error)
    }
}

impl core::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let base58 = |address: &Address| bs58::encode(address.0).into_string();

        match self {
            Self::Plan(error) => write!(f, "{error}"),
            Self::BadVerifyIntent(position) => write!(f, "the verify_intent at {position} does not decode"),
            Self::BadSegment(position) => write!(f, "the segment of the verify_intent at {position} is not whole"),
            Self::NonCanonicalBump(position) => {
                write!(f, "the verify_intent at {position} states a bump that is not canonical")
            }
            Self::WrongFeePayer(position) => write!(f, "the verify_intent at {position} names another fee payer"),
            Self::PayersDiffer => f.write_str("the verify_intent instructions name different rent payers"),
            Self::NotAVersion(address) => write!(f, "{} is not the version account of its document", base58(address)),
        }
    }
}

impl std::error::Error for VerifyError {}

/// One `verify_intent`, read in place from its instruction.
struct DecodedVerify<'t> {
    position: usize,
    instruction: &'t Instruction,
    intent: &'t [u8],
    outputs: &'t [u8],
    /// The bumps that `verify_intent` derives the record's program addresses with.
    bumps: &'t [u8],
    rent_cap: u64,
    segment: Range<usize>,
    built: Range<usize>,
}

/// The accounts that a segment's message still needs, or the message.
enum Part {
    Missing(Vec<Address>),
    Rendered(String),
}

/// Verifies `transaction` against `chain`, which holds the accounts that earlier steps asked for.
pub fn verify_transaction<C: Chain>(transaction: &Transaction, chain: &C) -> Result<VerifyStep, VerifyError> {
    let verifies = decode_all(transaction)?;
    let rent_payer = verifies.first().map(|verify| account(verify, RENT_PAYER)).transpose()?;

    if verifies.iter().any(|verify| account(verify, RENT_PAYER).ok() != rent_payer) {
        return Err(VerifyError::PayersDiffer);
    }

    let rent_payer = rent_payer.unwrap_or(transaction.fee_payer);
    let payers = Payers { fee: &transaction.fee_payer, rent: &rent_payer };
    let parts = verifies.iter().map(|verify| part(verify, payers, chain)).collect::<Result<Vec<_>, _>>()?;

    let missing: Vec<Address> = parts.iter().fold(Vec::new(), |mut missing, part| {
        if let Part::Missing(addresses) = part {
            missing.extend(addresses.iter().filter(|address| !missing.contains(address)).copied().collect::<Vec<_>>());
        }

        missing
    });

    if !missing.is_empty() {
        return Ok(VerifyStep::Fetch(missing));
    }

    let rendered: Vec<String> =
        parts.into_iter().filter_map(|part| if let Part::Rendered(text) = part { Some(text) } else { None }).collect();
    let in_segment = |position: &usize| verifies.iter().any(|verify| verify.segment.contains(position));
    let unverified = (0..transaction.instructions.len())
        .filter(|position| !in_segment(position))
        .filter(|position| transaction.instructions.get(*position).is_some_and(|instruction| !instruction.is_budget()))
        .collect();

    Ok(VerifyStep::Done(Box::new(VerifiedTransaction {
        message: plan_message(payers, transaction.priority_fee_lamports, &rendered),
        intents: verifies
            .iter()
            .map(|verify| VerifiedIntent {
                verify: verify.position,
                built: verify.built.clone(),
                segment: verify.segment.clone(),
            })
            .collect(),
        unverified,
    })))
}

/// Every `verify_intent` of the transaction, in order. No segment may hold another `verify_intent`.
fn decode_all(transaction: &Transaction) -> Result<Vec<DecodedVerify<'_>>, VerifyError> {
    let discriminator = verify_intent_discriminator();
    let verifies = transaction
        .instructions
        .iter()
        .enumerate()
        .filter(|(_, instruction)| {
            instruction.program == REGISTRY_PROGRAM && instruction.data.starts_with(&discriminator)
        })
        .map(|(position, instruction)| decode(transaction, position, instruction))
        .collect::<Result<Vec<_>, _>>()?;

    let nested = verifies.iter().find(|verify| {
        verifies.iter().any(|other| other.position != verify.position && verify.segment.contains(&other.position))
    });

    match nested {
        Some(verify) => Err(VerifyError::BadSegment(verify.position)),
        None => Ok(verifies),
    }
}

fn decode<'t>(
    transaction: &'t Transaction,
    position: usize,
    instruction: &'t Instruction,
) -> Result<DecodedVerify<'t>, VerifyError> {
    let bad = || VerifyError::BadVerifyIntent(position);
    let mut data = Reader(instruction.data.get(8..).ok_or_else(bad)?);
    let intent = data.bytes().ok_or_else(bad)?;
    data.bytes().ok_or_else(bad)?;
    let outputs = data.bytes().ok_or_else(bad)?;
    let bumps = data.bytes().ok_or_else(bad)?;
    data.bytes().ok_or_else(bad)?;
    let Some((rent_cap, &[_guarded, snapshots, built, checks])) = data.0.split_first_chunk::<8>() else {
        return Err(bad());
    };
    let rent_cap = u64::from_le_bytes(*rent_cap);

    if instruction.accounts.get(FEE_PAYER).map(|meta| meta.address) != Some(transaction.fee_payer) {
        return Err(VerifyError::WrongFeePayer(position));
    }

    let start = position.checked_add(1).ok_or_else(bad)?;
    let built_start = start.checked_add(usize::from(snapshots)).ok_or_else(bad)?;
    let built_end = built_start.checked_add(usize::from(built)).ok_or_else(bad)?;
    let end = built_end.checked_add(usize::from(checks)).ok_or_else(bad)?;

    if end > transaction.instructions.len() {
        return Err(VerifyError::BadSegment(position));
    }

    Ok(DecodedVerify {
        position,
        instruction,
        intent,
        outputs,
        bumps,
        rent_cap,
        segment: position..end,
        built: built_start..built_end,
    })
}

/// The intent's part of the message, rendered from the documents in the version accounts.
fn part<C: Chain>(verify: &DecodedVerify<'_>, payers: Payers<'_>, chain: &C) -> Result<Part, VerifyError> {
    let intent = Intent::parse(verify.intent).map_err(|_| VerifyError::BadVerifyIntent(verify.position))?;
    let interface_version = account(verify, INTERFACE_VERSION)?;
    let implementation_version = account(verify, IMPLEMENTATION_VERSION)?;

    let (Some(interface), Some(implementation)) =
        (chain.account(&interface_version), chain.account(&implementation_version))
    else {
        return Ok(Part::Missing(vec![interface_version, implementation_version]));
    };

    let interface = document(&interface_version, &interface, DocumentKind::Interface, intent.interface())?;
    let implementation =
        document(&implementation_version, &implementation, DocumentKind::Implementation, intent.implementation())?;
    let mut recipe = Recipe::parse(interface, implementation, verify.intent, payers).map_err(PlanError::from)?;

    if let Resolution::Missing(missing) = recipe.resolve(chain).map_err(PlanError::from)? {
        return Ok(Part::Missing(missing.addresses().copied().collect()));
    }

    if recipe.bumps().map_err(PlanError::from)?.as_slice() != verify.bumps {
        return Err(VerifyError::NonCanonicalBump(verify.position));
    }

    let values = Values { recipe: &recipe, chain, outputs: verify.outputs };
    let missing: Vec<Address> =
        values.message_accounts()?.into_iter().filter(|address| chain.account(address).is_none()).collect();

    if !missing.is_empty() {
        return Ok(Part::Missing(missing));
    }

    let message = values.message()?;

    Ok(Part::Rendered(with_rent_cap(&message, verify.rent_cap)))
}

/// The document in a version account that the registry owns at the address of `id`.
fn document<'c>(
    address: &Address,
    account: &sdp_intents_engine::AccountData<'c>,
    kind: DocumentKind,
    id: &sdp_intents_spec::wire::DocumentIdV1,
) -> Result<&'c [u8], VerifyError> {
    if *account.owner != REGISTRY_PROGRAM || version_address(kind, id)? != *address {
        return Err(VerifyError::NotAVersion(*address));
    }

    account.data.get(VERSION_HEADER_LEN..).ok_or(VerifyError::NotAVersion(*address))
}

fn account(verify: &DecodedVerify<'_>, index: usize) -> Result<Address, VerifyError> {
    verify.instruction.accounts.get(index).map(|meta| meta.address).ok_or(VerifyError::BadVerifyIntent(verify.position))
}

/// Reads borsh `Vec<u8>` arguments from the front of the data.
struct Reader<'d>(&'d [u8]);

impl<'d> Reader<'d> {
    fn bytes(&mut self) -> Option<&'d [u8]> {
        let (len, rest) = self.0.split_first_chunk::<4>()?;
        let (bytes, rest) = rest.split_at_checked(usize::try_from(u32::from_le_bytes(*len)).ok()?)?;
        self.0 = rest;

        Some(bytes)
    }
}
