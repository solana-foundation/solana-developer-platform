//! The JSON spellings of the values that a document holds.

use sdp_intents_spec::{Address, Encoding, ValueType};
use serde_json::Value;

use super::DecompileError;
use crate::encoding::{self, EncodingName};

/// Where a literal segment sits. A seed is usually text, and instruction data is usually bytes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum LiteralPlace {
    Seed,
    Data,
}

/// An object with its keys in the order given.
pub(super) fn object<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(entries.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

/// An object with its keys in the order given, without the keys whose value is `None`.
pub(super) fn sparse_object<const N: usize>(entries: [(&str, Option<Value>); N]) -> Value {
    Value::Object(entries.into_iter().filter_map(|(key, value)| Some((key.to_owned(), value?))).collect())
}

/// `None` for an empty list, so that the key is left out.
pub(super) fn non_empty(values: Vec<Value>) -> Option<Value> {
    (!values.is_empty()).then_some(Value::Array(values))
}

/// `true` when the flag is set. A flag that is not set is left out.
pub(super) fn flag(set: bool) -> Option<Value> {
    set.then_some(Value::Bool(true))
}

pub(super) fn utf8(bytes: &[u8]) -> Result<&str, DecompileError> {
    std::str::from_utf8(bytes).map_err(|_| DecompileError::NotUtf8)
}

pub(super) fn base58(address: &Address) -> String {
    bs58::encode(address.0).into_string()
}

pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `"u64"`, or `{ "array": "u64" }`.
pub(super) fn value_type(value_type: ValueType) -> Value {
    let base = Value::from(crate::value_type::name(value_type.base));

    if value_type.array {
        object([("array", base)])
    } else {
        base
    }
}

pub(super) fn encoding_name(wire: Encoding) -> Result<&'static str, DecompileError> {
    encoding::NAMES
        .iter()
        .find(|(_, name)| *name == EncodingName::Wire(wire))
        .map(|(text, _)| *text)
        .ok_or(DecompileError::Unrepresentable("an encoding that has no name"))
}

/// A seed of printable ASCII is `utf8` text, with its braces escaped. Every other literal is `hex`.
pub(super) fn literal(bytes: &[u8], place: LiteralPlace) -> Value {
    let printable = !bytes.is_empty() && bytes.iter().all(|byte| (b' '..=b'~').contains(byte));
    let text = std::str::from_utf8(bytes).ok().filter(|_| printable && place == LiteralPlace::Seed);

    match text {
        Some(text) => object([
            ("value", Value::from(text.replace('{', "{{").replace('}', "}}"))),
            ("encoding", Value::from("utf8")),
        ]),
        None => object([("value", Value::from(hex(bytes))), ("encoding", Value::from("hex"))]),
    }
}
