//! The implementation record. `wire` holds the stored structs, with their decoders beside them in
//! `account` and `segment`. `view` finds tables in a document without copying them.

mod account;
mod payload;
mod segment;
mod validate;
mod view;
mod wire;

pub use account::AddressSource;
pub use segment::Segment;
pub use view::Implementation;
pub use wire::{
    AccountSourceKind, AccountV1, AppliesKind, AppliesV1, CheckKind, Encoding, ImplementationDocV1, InstructionV1,
    LiteralV1, OutputBindingV1, PostConditionV1, RecipeKind, SegmentSourceKind, SegmentV1,
};
