//! A flow step's binding to its flow (`DESIGN.md`, 4.19): the flow names the step's interface and
//! implementation at its position, and each step input is the value that the flow binds to it. The
//! signer's verifier and `verify_intent` both check it.

use crate::wire::{DocumentIdV1, StepInputV1};
use crate::{Address, Intent, RecipeKind, SpecError, ValueRef, ValueSource};

use super::view::Implementation;

/// A step of a flow, as a step's `verify_intent` states it.
#[derive(Clone, Copy)]
pub struct StepBinding<'a> {
    pub flow: Implementation<'a>,
    /// The flow's own intent.
    pub flow_intent: Intent<'a>,
    /// The step's position, from zero.
    pub step: u8,
    pub fee_payer: &'a Address,
    pub rent_payer: &'a Address,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BindingError {
    Spec(SpecError),
    /// The intent is not the flow's step at the position, with the inputs that the flow binds.
    NotTheStep,
}

impl From<SpecError> for BindingError {
    fn from(error: SpecError) -> Self {
        Self::Spec(error)
    }
}

/// `step` is the flow's step at `binding.step`.
pub fn check_step_binding(binding: &StepBinding<'_>, step: &Intent<'_>) -> Result<(), BindingError> {
    let flow = binding.flow;
    let outer = binding.flow_intent;
    let flow_named = flow.recipe()? == RecipeKind::Flow
        && outer.implementation() == flow.id()
        && accepts(flow.implements(), outer.interface());

    if !flow_named {
        return Err(BindingError::NotTheStep);
    }

    let named = flow.steps()?.get(usize::from(binding.step)).ok_or(BindingError::NotTheStep)?;
    let pinned =
        accepts(&named.interface.id, step.interface()) && accepts(&named.implementation.id, step.implementation());
    let inputs = flow.step_inputs(named)?;

    if !pinned || inputs.len() != step.inputs()?.len() {
        return Err(BindingError::NotTheStep);
    }

    inputs.iter().zip(0u8..).try_for_each(|(input, index)| match binds(binding, input, step.input(index)?)? {
        true => Ok(()),
        false => Err(BindingError::NotTheStep),
    })
}

/// The flow input, payer, or literal that the flow binds equals what the step's intent holds. A
/// value that only a plan knows, such as an earlier step's output, cannot be checked, so it never
/// binds.
fn binds(binding: &StepBinding<'_>, input: &StepInputV1, held: &[u8]) -> Result<bool, SpecError> {
    let value = ValueRef::try_from(input.value)?;

    Ok(match value.source {
        ValueSource::Input => binding.flow_intent.input(value.index)? == held,
        ValueSource::Payer if value.index == 0 => held == binding.fee_payer.0,
        ValueSource::Payer => held == binding.rent_payer.0,
        ValueSource::Literal => {
            let literal = binding.flow.literals()?.get(usize::from(value.index)).ok_or(SpecError::BadIndex)?;

            binding.flow.text(literal.bytes)? == held
        }
        ValueSource::None => held == [0],
        _ => false,
    })
}

/// `named` holds the lowest version that a caret range accepts: the same major version, at a
/// version no lower.
fn accepts(named: &DocumentIdV1, held: &DocumentIdV1) -> bool {
    let version = |id: &DocumentIdV1| (id.version.major.get(), id.version.minor.get(), id.version.patch.get());

    named.publisher == held.publisher
        && named.name_hash == held.name_hash
        && named.version.major.get() == held.version.major.get()
        && version(held) >= version(named)
}
