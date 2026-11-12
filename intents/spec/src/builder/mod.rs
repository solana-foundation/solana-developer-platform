//! The builder ABI: what a builder instruction returns, in staged mode and in hashed mode. A builder
//! writes these layouts, and the service and `verify_intent` read them with the views.

mod result;
mod wire;

pub use result::{HashedReady, Ready, ReadyInstruction, ReadyInstructions, Refused, StagedResult};
pub use wire::{
    AccountMetaV1, HashedReadyV1, InstructionHeaderV1, ReadyHeaderV1, ResultKind, ResultPointerV1, MAX_HASHED_TAIL,
    PAYER_RENT_PLACEHOLDER,
};
