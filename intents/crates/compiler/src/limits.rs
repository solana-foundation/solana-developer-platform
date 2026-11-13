//! The limits of DESIGN.md 4.9. A document that needs more uses a builder.

use crate::diagnostic::{Code, Diagnostic};
use crate::reader::Sink;

pub const DOCUMENT_BYTES: usize = 10_000;
pub const POOL_BYTES: usize = 4_096;
pub const TEMPLATE_BYTES: usize = 256;
pub const INPUTS: usize = 16;
pub const OUTPUTS: usize = 8;
pub const POST_CONDITIONS: usize = 8;
pub const APPLIES: usize = 4;
pub const ADDRESSES: usize = 32;
pub const ACCOUNTS: usize = 32;
pub const SEEDS: usize = 32;
pub const INSTRUCTIONS: usize = 12;
pub const SEGMENTS: usize = 48;

/// Adds a finding when `count` is over `limit`. `what` names the counted things, such as
/// `accounts`.
pub fn check(sink: &mut Sink, pointer: &str, what: &str, count: usize, limit: usize) {
    if count > limit {
        sink.push(
            Diagnostic::new(Code::LimitExceeded, pointer, format!("{count} {what}, and the limit is {limit}"))
                .help("an implementation that needs more than a limit uses a builder program"),
        );
    }
}
