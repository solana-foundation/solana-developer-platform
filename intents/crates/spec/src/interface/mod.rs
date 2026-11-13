//! The interface: inputs, outputs, a display, and post conditions.

mod validate;
mod view;
mod wire;

pub use view::Interface;
pub use wire::{InputV1, InterfaceDocV1, OutputV1, INTERFACE_SETTLES_LATER};
