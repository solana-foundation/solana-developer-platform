//! Compiles SDP definitions and intents from JSON to their binary form, and lints them.
//!
//! A [`Catalog`] compiles each document and keeps it, so that a later document can name it. Compile
//! the interfaces first, then the implementations, then the intents. A compile returns the bytes, or
//! a [`diagnostic::Report`] with every finding in the file.
//!
//! ```
//! use sdp_intents_compiler::diagnostic::Report;
//! use sdp_intents_compiler::Catalog;
//! use sdp_intents_spec::Address;
//!
//! fn compile_intent(interface: &str, implementation: &str, intent: &str) -> Result<Vec<u8>, Report> {
//!     let mut catalog = Catalog::default().with_publisher("solana.org", Address([7; 32]));
//!     catalog.compile_interface(interface)?;
//!     catalog.compile_implementation(implementation)?;
//!     catalog.compile_intent(intent).map(|intent| intent.bytes)
//! }
//! # let compiled = compile_intent(
//! #     include_str!("../../definitions/solana.org/interfaces/token.transfer/1.0.0.json"),
//! #     include_str!("../../definitions/solana.org/implementations/system-transfer/1.0.0.json"),
//! #     include_str!("../../fixtures/intents/system-transfer.json"),
//! # );
//! # assert!(compiled.is_ok());
//! ```
//!
//! [`diagnostic::Report::render`] shows each finding with its file, line, column, and a caret under
//! the value, in the style of `rustc`. The compiler parses each document that it writes with the
//! view of `sdp-intents-spec`, so a document that compiles also parses onchain.

mod borsh;
mod catalog;
pub mod diagnostic;
mod encoding;
mod envelope;
mod id;
mod implementation;
mod intent;
mod interface;
mod limits;
mod plan;
mod post_condition;
mod reader;
mod reference;
mod resolve;
mod scope;
mod spans;
mod suggest;
mod template;
mod value_type;
mod writer;

#[cfg(test)]
mod test_support;

pub use catalog::Catalog;
pub use id::Id;
pub use implementation::CompiledImplementation;
pub use intent::CompiledIntent;
pub use interface::CompiledInterface;
pub use plan::{CompiledPlan, PlanPayers};
