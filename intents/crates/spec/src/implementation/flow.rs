//! A flow recipe (`DESIGN.md`, 4.19): steps that each name an interface, with conditions on chain
//! state. Spec 1.1 adds it. The flow's fixed part is the document's extension area, and its tables
//! lie in the body, as every table does.

use bytemuck::{Pod, Zeroable};

use super::view::Implementation;
use crate::code::wire_code;
use crate::counts::check_index;
use crate::{DocumentIdV1, PoolRefV1, RangeV1, SpecError, TableRefV1, ValueRef, ValueRefV1, ValueSource};

wire_code! {
    pub enum ConditionKind {
        /// `args` are the account.
        Exists = 1,
        Absent = 2,
        /// `args` are the owner, the mint, and the minimum, in base units.
        Balance = 3,
        /// As `Balance`, for the owner's unspent notes in a privacy ring.
        PrivateBalance = 4,
        /// `args` are the nullifiers that a step's plan fixed. Holds when a transaction spent them.
        Spent = 5,
    }
}

wire_code! {
    pub enum Submitter {
        /// The step's signers approve it.
        Signer = 0,
        /// The step needs no approval, and only the owner's keys can build it.
        Owner = 1,
        /// The step needs no approval, and anyone can build it.
        Anyone = 2,
    }
}

/// A step's `ready` or `done` names no condition.
pub const NO_CONDITION: u8 = u8::MAX;

/// The facts that a step's plan fixes, by `StepFact` index.
pub const STEP_FACT_NULLIFIERS: u8 = 0;

/// A `StepOutput` or `StepFact` value names its step in the high five bits of its index and the
/// output or the fact in the low three.
const STEP_SHIFT: u8 = 3;
const PER_STEP: u8 = 1 << STEP_SHIFT;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct FlowDocV1 {
    pub steps: TableRefV1,
    pub step_inputs: TableRefV1,
    pub conditions: TableRefV1,
}

/// An interface or an implementation that a step names. `name` holds its name, such as
/// `private.shield`, because the id holds only its hash. An empty name names no document.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct DocumentRefV1 {
    pub id: DocumentIdV1,
    pub name: PoolRefV1,
}

/// An input of a step's interface, by name, and its value. A step lists its interface's inputs in
/// order.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct StepInputV1 {
    pub name: PoolRefV1,
    pub value: ValueRefV1,
}

/// The version of each id is the lowest that the step accepts, as for `implements`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct StepV1 {
    pub name: PoolRefV1,
    pub interface: DocumentRefV1,
    /// Empty when the planner matches an implementation with `applies`.
    pub implementation: DocumentRefV1,
    pub inputs: RangeV1,
    pub ready: u8,
    pub done: u8,
    /// Empty when the step leaves nothing to recover.
    pub recover: DocumentRefV1,
    pub recover_inputs: RangeV1,
    pub submitter: u8,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct ConditionV1 {
    pub kind: u8,
    /// An unused argument has source `None`.
    pub args: [ValueRefV1; 3],
    pub message: PoolRefV1,
}

impl DocumentRefV1 {
    pub fn is_empty(&self) -> bool {
        self.name.len.get() == 0
    }
}

/// The step and the output or fact of a `StepOutput` or `StepFact` value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StepValue {
    pub step: u8,
    pub item: u8,
}

impl StepValue {
    pub fn of(value: ValueRef) -> Option<Self> {
        matches!(value.source, ValueSource::StepOutput | ValueSource::StepFact)
            .then_some(Self { step: value.index >> STEP_SHIFT, item: value.index % PER_STEP })
    }

    pub fn index(self) -> Option<u8> {
        (self.item < PER_STEP).then(|| self.step.checked_mul(PER_STEP)).flatten().map(|base| base | self.item)
    }
}

impl<'a> Implementation<'a> {
    /// The flow tables, when the recipe is a flow.
    pub fn flow(&self) -> Result<Option<&'a FlowDocV1>, SpecError> {
        if self.extension().is_empty() {
            return Ok(None);
        }

        crate::region::Region::new(self.extension()).fixed(0).map(Some)
    }

    pub fn steps(&self) -> Result<&'a [StepV1], SpecError> {
        self.flow_table(|flow| flow.steps)
    }

    pub fn conditions(&self) -> Result<&'a [ConditionV1], SpecError> {
        self.flow_table(|flow| flow.conditions)
    }

    pub fn step_inputs(&self, step: &StepV1) -> Result<&'a [StepInputV1], SpecError> {
        self.step_values(step.inputs)
    }

    pub fn recover_inputs(&self, step: &StepV1) -> Result<&'a [StepInputV1], SpecError> {
        self.step_values(step.recover_inputs)
    }

    /// The condition at `index`, or `None` for `NO_CONDITION`.
    pub fn condition(&self, index: u8) -> Result<Option<&'a ConditionV1>, SpecError> {
        if index == NO_CONDITION {
            return Ok(None);
        }

        self.conditions()?.get(usize::from(index)).map(Some).ok_or(SpecError::OutOfBounds)
    }

    fn step_values(&self, range: RangeV1) -> Result<&'a [StepInputV1], SpecError> {
        let values = self.flow_table(|flow| flow.step_inputs)?;

        values.get(range.within(values.len())?).ok_or(SpecError::OutOfBounds)
    }

    fn flow_table<T: Pod>(&self, table: impl Fn(&FlowDocV1) -> TableRefV1) -> Result<&'a [T], SpecError> {
        match self.flow()? {
            Some(flow) => self.table(table(flow)),
            None => Ok(&[]),
        }
    }

    /// Each step names an interface, a value for each of its inputs, conditions that exist, and
    /// only steps before it. A condition names steps that exist.
    pub(super) fn validate_flow(&self, literals: usize) -> Result<(), SpecError> {
        let steps = self.steps()?;

        if steps.is_empty() {
            return Err(SpecError::BadRecipe);
        }

        steps.iter().zip(0u8..).try_for_each(|(step, position)| self.check_step(step, position, literals))?;
        self.conditions()?.iter().try_for_each(|condition| self.check_condition(condition, steps.len(), literals))
    }

    fn check_step(&self, step: &StepV1, position: u8, literals: usize) -> Result<(), SpecError> {
        self.text(step.name)?;
        Submitter::try_from(step.submitter)?;

        if step.interface.is_empty() || (step.recover.is_empty() && step.recover_inputs.count > 0) {
            return Err(SpecError::BadRecipe);
        }

        [step.interface, step.implementation, step.recover]
            .iter()
            .try_for_each(|document| self.text(document.name).map(|_| ()))?;

        [step.ready, step.done].into_iter().try_for_each(|index| self.condition(index).map(|_| ()))?;

        let earlier = usize::from(position);
        self.step_inputs(step)?.iter().chain(self.recover_inputs(step)?).try_for_each(|input| {
            self.text(input.name)?;
            check_step_value(ValueRef::try_from(input.value)?, earlier, literals)
        })
    }

    fn check_condition(&self, condition: &ConditionV1, steps: usize, literals: usize) -> Result<(), SpecError> {
        self.text(condition.message)?;

        let args = condition.args.map(ValueRef::try_from);
        let [first, second, third] = args;
        let (first, second, third) = (first?, second?, third?);

        let used = match ConditionKind::try_from(condition.kind)? {
            ConditionKind::Exists | ConditionKind::Absent => 1,
            ConditionKind::Balance | ConditionKind::PrivateBalance => 3,
            ConditionKind::Spent => {
                let fact = StepValue::of(first).filter(|_| first.source == ValueSource::StepFact);

                if fact.is_none_or(|fact| fact.item != STEP_FACT_NULLIFIERS) {
                    return Err(SpecError::BadIndex);
                }

                1
            }
        };

        [first, second, third].into_iter().enumerate().try_for_each(|(place, value)| match place < used {
            true => check_step_value(value, steps, literals),
            false => check_none(value),
        })
    }
}

/// A step value names an input, a payer, a literal, or a step before `steps`.
fn check_step_value(value: ValueRef, steps: usize, literals: usize) -> Result<(), SpecError> {
    match value.source {
        ValueSource::None => check_none(value),
        ValueSource::Input => Ok(()),
        ValueSource::Payer if value.index <= 1 => Ok(()),
        ValueSource::Literal => check_index(value.index, literals),
        ValueSource::StepOutput | ValueSource::StepFact => {
            StepValue::of(value).ok_or(SpecError::BadIndex).and_then(|step| check_index(step.step, steps))
        }
        _ => Err(SpecError::BadIndex),
    }
}

fn check_none(value: ValueRef) -> Result<(), SpecError> {
    if value.source != ValueSource::None || value.index != 0 {
        return Err(SpecError::BadIndex);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::size_of;

    #[test]
    fn entry_layouts_are_pinned() {
        assert_eq!(size_of::<FlowDocV1>(), 9);
        assert_eq!(size_of::<DocumentRefV1>(), 74);
        assert_eq!(size_of::<StepV1>(), 233);
        assert_eq!(size_of::<ConditionV1>(), 11);
        assert_eq!(size_of::<StepInputV1>(), 6);
    }

    #[test]
    fn a_step_value_packs_its_step_and_item() {
        let value = StepValue { step: 2, item: STEP_FACT_NULLIFIERS };
        let index = value.index().unwrap();

        assert_eq!(index, 16);
        assert_eq!(StepValue::of(ValueRef { source: ValueSource::StepFact, index }), Some(value));
        assert_eq!(StepValue { step: 0, item: 8 }.index(), None);
    }
}
