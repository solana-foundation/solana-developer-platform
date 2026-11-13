//! A remote recipe's call: what the planner asks the endpoint, and what it reads back. The caller
//! makes the call. `sdp-intents-client` holds the JSON form of both.

use sdp_intents_engine::{EngineError, Recipe};
use sdp_intents_spec::Address;

use crate::plan::Built;
use crate::values::{Reader, Value};
use crate::{Instruction, PlanError};

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

/// What the endpoint returned: the instructions, and the outputs that the record leaves unbound.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteAnswer {
    pub instructions: Vec<Instruction>,
    pub outputs: Vec<RemoteOutput>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteOutput {
    pub name: String,
    pub address: Address,
}

pub(crate) fn call(recipe: &Recipe<'_>) -> Result<RemoteCall, PlanError> {
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

        Ok(Self { instructions: answer.instructions, signers: Vec::new(), outputs: outputs.concat() })
    }
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
