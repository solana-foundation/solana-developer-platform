//! The implementation. `wire` holds the stored structs, with their decoders beside them in
//! `account` and `segment`. `view` finds tables in a document without copying them.

mod account;
mod flow;
mod payload;
mod segment;
mod validate;
mod view;
mod wire;

pub use account::AddressSource;
pub use flow::{
    ConditionKind, ConditionV1, DocumentRefV1, FlowDocV1, StepInputV1, StepV1, StepValue, Submitter, NO_CONDITION,
    STEP_FACT_NULLIFIERS,
};
pub use segment::Segment;
pub use view::Implementation;
pub use wire::{
    AccountV1, AppliesKind, AppliesV1, Encoding, ImplementationDocV1, InstructionV1, OutputBindingV1, RecipeKind,
    SegmentV1,
};

#[cfg(test)]
pub(crate) use wire::{AccountSourceKind, SegmentSourceKind};
