//! A flow's guarantees, proved from its steps' (`DESIGN.md`, 4.19). Each step's transaction enforces
//! the step's own postconditions onchain, so a flow guarantee holds when the steps' guarantees imply
//! it at every point where the flow can stop.
//!
//! An upper bound holds at every stopping point when the steps' bounds add up to at most the flow's.
//! A recovery counts as a step, because it can run after any step. A lower bound does not hold
//! before the last step lands, so a flow cannot state an inflow.

use crate::interface::Interface;
use crate::wire::{PostConditionV1, StepInputV1};
use crate::{Address, CheckKind, SpecError, ValueRef, ValueSource};

use super::view::Implementation;

/// The flow's interface and the flow implementation.
#[derive(Clone, Copy)]
pub struct FlowDocuments<'a> {
    pub interface: Interface<'a>,
    pub flow: Implementation<'a>,
}

impl<'a> FlowDocuments<'a> {
    /// The message template of the postcondition at `condition`: the interface's first, then the
    /// flow's own, as `GuaranteeError` counts them.
    pub fn guarantee_message(&self, condition: usize) -> Result<&'a [u8], SpecError> {
        let interface = self.interface.post_conditions()?;
        let check = interface.get(condition).map(|check| self.interface.text(check.message));
        let own = || {
            let own = self.flow.post_conditions()?;
            let check = own.get(condition.saturating_sub(interface.len())).ok_or(SpecError::BadIndex)?;

            self.flow.text(check.message)
        };

        check.unwrap_or_else(own)
    }
}

/// The documents that a step, or a step's recovery, pins, and the flow values of its interface's
/// inputs.
#[derive(Clone, Copy)]
pub struct StepDocuments<'a> {
    pub interface: Interface<'a>,
    pub implementation: Implementation<'a>,
    pub inputs: &'a [StepInputV1],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuaranteeError {
    Spec(SpecError),
    /// The flow states an inflow, which a flow that stops early has not received.
    Inflow {
        condition: usize,
    },
    /// The flow states a check that only an implementation with programs can state.
    InvokesOnly {
        condition: usize,
    },
    /// The steps' guarantees do not imply the flow's postcondition at this position: the
    /// interface's postconditions, then the flow's own.
    Unproved {
        condition: usize,
    },
}

impl From<SpecError> for GuaranteeError {
    fn from(error: SpecError) -> Self {
        Self::Spec(error)
    }
}

/// Every postcondition of the flow, from its interface and its own, follows from `steps`.
pub fn check_flow_guarantees(flow: FlowDocuments<'_>, steps: &[StepDocuments<'_>]) -> Result<(), GuaranteeError> {
    let targets = Conditions::of_flow(flow);
    targets.read_all()?;
    steps.iter().try_for_each(|step| Conditions::of_step(flow, *step).read_all())?;

    targets.read().enumerate().try_for_each(|(condition, target)| {
        match target.kind {
            CheckKind::Inflow => return Err(GuaranteeError::Inflow { condition }),
            CheckKind::InvokesOnly => return Err(GuaranteeError::InvokesOnly { condition }),
            _ => {}
        }

        let tally = steps
            .iter()
            .map(|step| share(Conditions::of_step(flow, *step), &targets, &target))
            .fold(Tally::default(), Tally::add);

        match tally.holds(&target) {
            true => Ok(()),
            false => Err(GuaranteeError::Unproved { condition }),
        }
    })
}

/// A value as the flow sees it: one of the flow's inputs or payers, fixed bytes, or a value that
/// only a plan knows, which equals nothing.
#[derive(Clone, Copy, Debug)]
enum Symbol<'a> {
    FlowInput(u8),
    Payer(u8),
    Bytes(&'a [u8]),
    /// The bound of a `NoOutflow`.
    Zero,
    Opaque,
}

impl Symbol<'_> {
    fn same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::FlowInput(left), Self::FlowInput(right)) | (Self::Payer(left), Self::Payer(right)) => left == right,
            (Self::Bytes(left), Self::Bytes(right)) => left == right,
            (Self::Zero, Self::Zero) => true,
            _ => false,
        }
    }

    /// A little-endian amount, when the bytes are one.
    fn amount(&self) -> Option<u128> {
        let bytes = match self {
            Self::Bytes(bytes) => bytes,
            Self::Zero => return Some(0),
            _ => return None,
        };
        let mut padded = [0u8; 16];
        padded.get_mut(..bytes.len())?.copy_from_slice(bytes);

        Some(u128::from_le_bytes(padded))
    }
}

/// The document whose tables a postcondition's literals and addresses index.
#[derive(Clone, Copy)]
enum Doc<'a> {
    Interface(Interface<'a>),
    Implementation(Implementation<'a>),
}

impl<'a> Doc<'a> {
    fn post_conditions(&self) -> Result<&'a [PostConditionV1], SpecError> {
        match self {
            Doc::Interface(doc) => doc.post_conditions(),
            Doc::Implementation(doc) => doc.post_conditions(),
        }
    }

    fn literal(&self, index: u8) -> Result<&'a [u8], SpecError> {
        let index = usize::from(index);

        match self {
            Doc::Interface(doc) => doc.text(doc.literals()?.get(index).ok_or(SpecError::BadIndex)?.bytes),
            Doc::Implementation(doc) => doc.text(doc.literals()?.get(index).ok_or(SpecError::BadIndex)?.bytes),
        }
    }

    fn address(&self, index: u8) -> Result<&'a Address, SpecError> {
        let addresses = match self {
            Doc::Interface(doc) => doc.addresses()?,
            Doc::Implementation(doc) => doc.addresses()?,
        };

        addresses.get(usize::from(index)).ok_or(SpecError::BadIndex)
    }

    /// A value that is the same in every plan: a payer, a literal, or an address.
    fn fixed(&self, value: ValueRef) -> Result<Symbol<'a>, SpecError> {
        Ok(match value.source {
            ValueSource::Payer => Symbol::Payer(value.index),
            ValueSource::Literal => Symbol::Bytes(self.literal(value.index)?),
            ValueSource::Address => Symbol::Bytes(&self.address(value.index)?.0),
            _ => Symbol::Opaque,
        })
    }
}

/// The postconditions of a flow, or of one step, read as the flow sees their values. A step's
/// input is the flow value that the step binds to it.
#[derive(Clone, Copy)]
struct Conditions<'a> {
    flow: FlowDocuments<'a>,
    step: Option<StepDocuments<'a>>,
}

impl<'a> Conditions<'a> {
    fn of_flow(flow: FlowDocuments<'a>) -> Self {
        Self { flow, step: None }
    }

    fn of_step(flow: FlowDocuments<'a>, step: StepDocuments<'a>) -> Self {
        Self { flow, step: Some(step) }
    }

    fn docs(&self) -> [Doc<'a>; 2] {
        match self.step {
            Some(step) => [Doc::Interface(step.interface), Doc::Implementation(step.implementation)],
            None => [Doc::Interface(self.flow.interface), Doc::Implementation(self.flow.flow)],
        }
    }

    fn symbol(&self, doc: Doc<'a>, value: ValueRef) -> Result<Symbol<'a>, SpecError> {
        match (value.source, self.step) {
            (ValueSource::None, _) => Ok(Symbol::Opaque),
            (ValueSource::Input, None) => Ok(Symbol::FlowInput(value.index)),
            (ValueSource::Input, Some(step)) => {
                let bound = step.inputs.get(usize::from(value.index)).ok_or(SpecError::BadIndex)?;

                Self::of_flow(self.flow).symbol(Doc::Implementation(self.flow.flow), ValueRef::try_from(bound.value)?)
            }
            _ => doc.fixed(value),
        }
    }

    fn condition(&self, doc: Doc<'a>, check: &PostConditionV1) -> Result<Condition<'a>, SpecError> {
        let kind = CheckKind::try_from(check.check)?;
        let symbol = |value| self.symbol(doc, ValueRef::try_from(value)?);
        let [first, second, third] = check.args.map(symbol);
        let delegate = if kind == CheckKind::Delegates { symbol(check.delegate())? } else { Symbol::Opaque };

        // A `NoOutflow` is an outflow bounded at zero.
        Ok(match kind {
            CheckKind::NoOutflow => {
                Condition { kind: CheckKind::Outflow, args: [first?, second?, Symbol::Zero, delegate] }
            }
            _ => Condition { kind, args: [first?, second?, third?, delegate] },
        })
    }

    fn checked(&self) -> impl Iterator<Item = Result<Condition<'a>, SpecError>> + Clone + 'a {
        let this = *self;

        self.docs().into_iter().flat_map(move |doc| {
            let checks = doc.post_conditions().unwrap_or_default();

            checks.iter().map(move |check| this.condition(doc, check))
        })
    }

    /// Fails on the first postcondition that does not read, or a table that does not.
    fn read_all(&self) -> Result<(), SpecError> {
        self.docs().iter().try_for_each(|doc| doc.post_conditions().map(|_| ()))?;

        self.checked().try_for_each(|condition| condition.map(|_| ()))
    }

    /// Every postcondition, once `read_all` has passed.
    fn read(&self) -> impl Iterator<Item = Condition<'a>> + Clone + 'a {
        self.checked().flatten()
    }
}

/// A postcondition with its values resolved: `args` as `CheckKind` orders them, then the delegate.
#[derive(Clone, Copy, Debug)]
struct Condition<'a> {
    kind: CheckKind,
    args: [Symbol<'a>; 4],
}

impl Condition<'_> {
    /// The same check on the same first `args` values as `target`.
    fn names(&self, kind: CheckKind, target: &Condition<'_>, args: usize) -> bool {
        self.kind == kind && self.args.iter().zip(&target.args).take(args).all(|(left, right)| left.same(right))
    }
}

/// What one step contributes to a flow postcondition.
#[derive(Clone, Copy, Debug)]
enum Share {
    /// The step moves none of the bounded amount, or keeps the check.
    Nothing,
    /// The step may move up to this many base units.
    Amount(u128),
    /// The step may move up to the flow's own bound, which names a flow value.
    Whole,
    Unbounded,
}

/// The steps' shares of one flow postcondition, added up.
#[derive(Clone, Copy, Debug, Default)]
struct Tally {
    wholes: usize,
    amounts: u128,
    unbounded: bool,
}

impl Tally {
    fn add(self, share: Share) -> Self {
        match share {
            Share::Nothing => self,
            Share::Amount(amount) => Self { amounts: self.amounts.saturating_add(amount), ..self },
            Share::Whole => Self { wholes: self.wholes.saturating_add(1), ..self },
            Share::Unbounded => Self { unbounded: true, ..self },
        }
    }

    /// A literal bound takes literal shares up to it. A bound that names a flow value takes one
    /// step's whole share and nothing else.
    fn holds(&self, target: &Condition<'_>) -> bool {
        match (target.kind, target.args[2].amount()) {
            _ if self.unbounded => false,
            (CheckKind::Outflow | CheckKind::Delegates, Some(max)) => self.wholes == 0 && self.amounts <= max,
            (CheckKind::Outflow | CheckKind::Delegates, None) => self.amounts == 0 && self.wholes <= 1,
            _ => true,
        }
    }
}

/// How one step bounds `target`. `flow` holds the flow's own postconditions, which a step's
/// outflow on another mint must fall under when the flow states that nothing else leaves.
fn share(step: Conditions<'_>, flow: &Conditions<'_>, target: &Condition<'_>) -> Share {
    let stated = step.read();
    let keeps = |kind: CheckKind, args: usize| stated.clone().any(|condition| condition.names(kind, target, args));

    match target.kind {
        CheckKind::Outflow => {
            let bounds = stated.clone().filter(|condition| condition.names(CheckKind::Outflow, target, 2));

            match bounds.map(|condition| bound_share(&condition.args[2], target)).min_by_key(rank) {
                Some(share) => share,
                None if keeps(CheckKind::NoOtherOutflows, 1) => Share::Nothing,
                None => Share::Unbounded,
            }
        }
        CheckKind::NoOtherOutflows => {
            let flow_bounds =
                |condition: &Condition<'_>| flow.read().any(|bound| bound.names(CheckKind::Outflow, condition, 2));
            let strays = stated
                .clone()
                .filter(|condition| condition.names(CheckKind::Outflow, target, 1))
                .any(|condition| condition.args[2].amount() != Some(0) && !flow_bounds(&condition));

            if keeps(CheckKind::NoOtherOutflows, 1) && !strays {
                Share::Nothing
            } else {
                Share::Unbounded
            }
        }
        CheckKind::Delegates => {
            let same_delegate = |condition: &Condition<'_>| {
                condition.names(CheckKind::Delegates, target, 2) && condition.args[3].same(&target.args[3])
            };
            let bound = stated.clone().filter(same_delegate).map(|condition| bound_share(&condition.args[2], target));

            match bound.min_by_key(rank) {
                _ if keeps(CheckKind::NoDelegate, 2) => Share::Nothing,
                Some(share) => share,
                None => Share::Unbounded,
            }
        }
        CheckKind::NoDelegate if keeps(CheckKind::NoDelegate, 2) => Share::Nothing,
        CheckKind::NoAuthorityChange if keeps(CheckKind::NoAuthorityChange, 1) => Share::Nothing,
        _ => Share::Unbounded,
    }
}

fn bound_share(max: &Symbol<'_>, target: &Condition<'_>) -> Share {
    match (max.amount(), target.args[2].amount()) {
        (Some(0), _) => Share::Nothing,
        (Some(amount), Some(_)) => Share::Amount(amount),
        _ if max.same(&target.args[2]) => Share::Whole,
        _ => Share::Unbounded,
    }
}

/// Tighter shares first, so a step's best bound counts.
fn rank(share: &Share) -> u8 {
    match share {
        Share::Nothing => 0,
        Share::Amount(_) => 1,
        Share::Whole => 2,
        Share::Unbounded => 3,
    }
}
