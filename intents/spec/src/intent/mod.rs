//! The intent: the interface and implementation versions, the payers, the options, and one value for
//! each input of the interface.

mod view;
mod wire;

pub use view::Intent;
pub use wire::{IntentDocV1, IntentOptions};
