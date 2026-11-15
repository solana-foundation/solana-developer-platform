//! The implementation. `wire` holds the stored structs, with their decoders beside them in
//! `account` and `segment`. `view` finds tables in a document without copying them.

mod account;
mod binding;
mod flow;
mod guarantees;
mod payload;
mod segment;
mod shielded;
mod validate;
mod view;
mod wire;

pub use account::AddressSource;
pub use binding::{check_step_binding, BindingError, StepBinding};
pub use flow::{
    ConditionKind, ConditionV1, DocumentRefV1, FlowDocV1, StepInputV1, StepV1, StepValue, Submitter, NO_CONDITION,
    STEP_FACT_NULLIFIERS,
};
pub use guarantees::{check_flow_guarantees, FlowDocuments, GuaranteeError, StepDocuments};
pub use segment::Segment;
pub use shielded::{ShieldedDocV1, ShieldedEntry, ShieldedProtocol};
pub use view::Implementation;
pub use wire::{
    AccountV1, AppliesKind, AppliesV1, Encoding, ImplementationDocV1, InstructionV1, OutputBindingV1, RecipeKind,
    SegmentV1,
};

#[cfg(test)]
pub(crate) use wire::{AccountSourceKind, SegmentSourceKind};
