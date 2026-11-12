//! Compiles SDP intent definitions from JSON to their binary form, and lints them.
//!
//! A compile reads one file and reports every finding in it, not only the first. Each finding has a
//! stable code, a message, and the JSON pointer of the value it is about. `Report::render` shows the
//! file, the line, the column, and a caret under that value.
//!
//! The binary form is in `sdp-intents-spec`. The compiler checks each document it writes by parsing
//! it with the spec's view, so a document that compiles also parses onchain.

mod catalog;
mod diagnostic;
mod encoding;
mod envelope;
mod id;
mod implementation;
mod interface;
mod limits;
mod post_condition;
mod reader;
mod reference;
mod scope;
mod spans;
mod suggest;
mod template;
mod value_type;
mod writer;

#[cfg(test)]
mod test_support;

pub use catalog::Catalog;
pub use diagnostic::{Code, Diagnostic, Located, Location, Part, Report, SyntaxError};
pub use id::Id;
pub use implementation::compile_implementation;
pub use interface::{compile_interface, CompiledInterface};
pub use scope::{Field, Schema};
