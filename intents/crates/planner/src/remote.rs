//! A remote recipe's call: what the planner asks the endpoint, and what it reads back. The caller
//! makes the call. `sdp-intents-client` holds the JSON form of both.

use sdp_intents_engine::{EngineError, Recipe};
use sdp_intents_spec::Address;

use crate::plan::Built;
use crate::values::{Reader, Value};
use crate::{Instruction, PlanError, Transaction};

/// The call that a remote recipe needs. The endpoint is untrusted: the planner checks what it
/// returns as it checks any recipe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteCall {
    pub url: String,
    /// The interface's name and version, such as `vault.deposit` and `1.0.0`.
    pub interface: String,
    pub interface_version: String,
    pub implementation: String,
    pub inputs: Vec<RemoteInput>,
    pub fee_payer: Address,
    pub rent_payer: Address,
    /// A provider that returns a whole transaction must set this priority fee.
    pub priority_fee_lamports: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteInput {
    pub name: String,
    pub value: InputValue,
}

/// An input as the intent holds it. An integer is in base units.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InputValue {
    Absent,
    Unsigned(u128),
    Signed(i128),
    Bool(bool),
    Address(Address),
    Text(String),
    Bytes(Vec<u8>),
    List(Vec<InputValue>),
}

/// What the endpoint returned: the instructions, or a whole transaction that the provider signed,
/// and the outputs that the record leaves unbound.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteAnswer {
    pub instructions: Vec<Instruction>,
    pub outputs: Vec<RemoteOutput>,
    pub frozen: Option<FrozenTransaction>,
}

/// A whole transaction that a provider built and signed. Its signatures cover every byte of the
/// message, so the plan keeps the message as it is (`DESIGN.md`, 4.16).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrozenTransaction {
    /// The serialized message: legacy, v0, or v1.
    pub message: Vec<u8>,
    /// What the message decodes to, with the accounts of its lookup tables.
    pub transaction: Transaction,
    /// The lookup tables of a v0 message. A simulation loads them to run the message.
    pub lookup_tables: Vec<Address>,
    /// The provider's signatures. The caller checks each against `message`.
    pub signatures: Vec<ProviderSignature>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSignature {
    pub signer: Address,
    pub signature: [u8; 64],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteOutput {
    pub name: String,
    pub address: Address,
}

pub(crate) fn call(recipe: &Recipe<'_>, priority_fee_lamports: u64) -> Result<RemoteCall, PlanError> {
    let interface = recipe.interface();
    let implementation = recipe.implementation();
    let version = interface.id().version;
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();

    let inputs = interface
        .inputs()?
        .iter()
        .zip(0u8..)
        .map(|(input, index)| {
            let value = Reader(recipe.intent().input(index)?).read(input.value_type()?, input.optional())?;

            Ok(RemoteInput { name: text(interface.text(input.name)?), value: InputValue::from(value) })
        })
        .collect::<Result<Vec<_>, PlanError>>()?;

    Ok(RemoteCall {
        url: text(implementation.url()?),
        interface: text(interface.name()?),
        interface_version: format!("{}.{}.{}", version.major.get(), version.minor.get(), version.patch.get()),
        implementation: text(implementation.name()?),
        inputs,
        fee_payer: *recipe.payers().fee,
        rent_payer: *recipe.payers().rent,
        priority_fee_lamports,
    })
}

impl Built {
    /// The endpoint's instructions, with each output from the record when it binds one, and from the
    /// answer otherwise. An answer that names a bound output with another address is refused, and so
    /// is an answer that leaves an unbound output out.
    pub(crate) fn from_remote(recipe: &Recipe<'_>, answer: RemoteAnswer) -> Result<Self, PlanError> {
        let interface = recipe.interface();
        let outputs = interface
            .outputs()?
            .iter()
            .zip(0u8..)
            .map(|(output, index)| {
                let name = interface.text(output.name)?;
                let answered = answer.outputs.iter().find(|answered| answered.name.as_bytes() == name);

                match (recipe.output_address(index), answered) {
                    (Ok(bound), Some(answered)) if *bound != answered.address => Err(PlanError::RemoteOutput(index)),
                    (Ok(bound), _) => Ok(bound.0),
                    (Err(EngineError::UnboundOutput { .. }), Some(answered)) => Ok(answered.address.0),
                    (Err(EngineError::UnboundOutput { .. }), None) => Err(PlanError::RemoteOutput(index)),
                    (Err(error), _) => Err(error.into()),
                }
            })
            .collect::<Result<Vec<_>, PlanError>>()?;

        Ok(Self { instructions: answer.instructions, signers: Vec::new(), outputs: outputs.concat(), frozen: None })
    }

    /// A provider's transaction. It is the whole plan, so it has one intent and no onchain checks,
    /// the request's fee payer, at most the request's priority fee, and no signature for the owner,
    /// a payer, or a signer input. A legacy or v0 transaction sets its priority fee as a price for
    /// each compute unit, so the fee can round below the request's. Each other signature must be one that the record lists, or one for an account
    /// that the transaction creates, which `verify` checks in the simulation.
    pub(crate) fn from_frozen(
        recipe: &Recipe<'_>,
        answer: RemoteAnswer,
        priority_fee_lamports: u64,
    ) -> Result<Self, PlanError> {
        let frozen = answer.frozen.ok_or(PlanError::RemoteTransaction("the endpoint returned no transaction"))?;
        let options = recipe.intent().options()?;
        let payers = recipe.payers();

        if options.verify_intent || options.assertions {
            return Err(PlanError::RemoteTransaction("set `verifyIntent` and `assertions` to false to accept it"));
        }

        if frozen.transaction.fee_payer != *payers.fee {
            return Err(PlanError::RemoteTransaction("its fee payer is not the request's"));
        }

        if frozen.transaction.priority_fee_lamports > priority_fee_lamports {
            return Err(PlanError::RemoteTransaction("its priority fee is more than the request's"));
        }

        let user_signers = signer_inputs(recipe)?;
        let refused = frozen.signatures.iter().any(|signed| {
            signed.signer == *payers.fee || signed.signer == *payers.rent || user_signers.contains(&signed.signer)
        });

        if refused {
            return Err(PlanError::RemoteTransaction("the provider signed for a payer or a signer input"));
        }

        let outputs = Self::from_remote(recipe, RemoteAnswer { frozen: None, ..answer })?.outputs;
        let signers = frozen.signatures.iter().map(|signed| signed.signer).collect();
        let instructions =
            frozen.transaction.instructions.iter().filter(|instruction| !instruction.is_budget()).cloned();

        Ok(Self { instructions: instructions.collect(), signers, outputs, frozen: Some(frozen) })
    }
}

/// The address of each signer input that the intent holds.
fn signer_inputs(recipe: &Recipe<'_>) -> Result<Vec<Address>, PlanError> {
    let interface = recipe.interface();

    interface
        .inputs()?
        .iter()
        .zip(0u8..)
        .filter(|(input, _)| input.signer())
        .filter_map(|(input, index)| {
            match Reader(recipe.intent().input(index).ok()?).read(input.value_type().ok()?, input.optional()) {
                Ok(Value::Address(address)) => Some(Ok(address)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            }
        })
        .collect()
}

/// The signers that the record lists: its accounts with the signer flag.
pub(crate) fn record_signers(recipe: &Recipe<'_>) -> Result<Vec<Address>, PlanError> {
    let accounts = recipe.implementation().accounts()?;

    Ok((0u8..)
        .zip(accounts)
        .filter(|(_, account)| account.signer())
        .filter_map(|(index, _)| recipe.address(index).copied())
        .collect())
}

impl From<Value<'_>> for InputValue {
    fn from(value: Value<'_>) -> Self {
        match value {
            Value::Absent => Self::Absent,
            Value::Unsigned(integer) => Self::Unsigned(integer),
            Value::Signed(integer) => Self::Signed(integer),
            Value::Bool(flag) => Self::Bool(flag),
            Value::Address(address) => Self::Address(address),
            Value::Text(text) => Self::Text(text.to_owned()),
            Value::Bytes(bytes) => Self::Bytes(bytes.to_vec()),
            Value::List(items) => Self::List(items.into_iter().map(Self::from).collect()),
        }
    }
}
