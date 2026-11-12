//! Writes a JSON value in borsh for its value type, as an intent stores each input.
//!
//! An integer is a decimal string, such as `"100000000"`, or a JSON integer. An address or a mint
//! is base58, and `bytes` are hex digits.

use sdp_intents_spec::{BaseType, ValueType};

use crate::encoding::{address, integer_encoding_of, literal_bytes, EncodingName};
use crate::envelope::reported;
use crate::reader::{Node, Sink};
use crate::value_type::name;

pub fn encode(node: &Node<'_>, value_type: ValueType, sink: &mut Sink) -> Option<Vec<u8>> {
    if !value_type.array {
        return encode_base(node, value_type.base, sink);
    }

    let items = node.array(sink)?;
    let count = reported(length_prefix(items.len()), node, sink)?;
    let encoded: Option<Vec<Vec<u8>>> = items.iter().map(|item| encode_base(item, value_type.base, sink)).collect();

    Some([count.to_vec(), encoded?.concat()].concat())
}

fn encode_base(node: &Node<'_>, base: BaseType, sink: &mut Sink) -> Option<Vec<u8>> {
    match base {
        BaseType::Bool => node.bool(sink).map(|value| vec![u8::from(value)]),
        BaseType::Address | BaseType::Mint => {
            node.str(sink).and_then(|text| reported(address(text), node, sink)).map(|address| address.to_vec())
        }
        BaseType::String => node.str(sink).and_then(|text| prefixed(text.as_bytes(), node, sink)),
        BaseType::Bytes => node
            .str(sink)
            .and_then(|text| reported(literal_bytes(EncodingName::Hex, text), node, sink))
            .and_then(|bytes| prefixed(&bytes, node, sink)),
        integer => {
            let text = integer_text(node, integer, sink)?;
            let encoding = integer_encoding_of(integer)?;

            reported(literal_bytes(EncodingName::Wire(encoding), &text), node, sink)
        }
    }
}

/// A JSON number is accepted only when it is an integer, so that no value loses precision.
fn integer_text(node: &Node<'_>, base: BaseType, sink: &mut Sink) -> Option<String> {
    match node.value.as_number() {
        Some(number) if number.is_u64() || number.is_i64() => Some(number.to_string()),
        Some(number) => {
            reported(Err(format!("`{number}` is not an integer, and `{}` holds integers", name(base))), node, sink)
        }
        None => node.str(sink).map(str::to_owned),
    }
}

fn prefixed(bytes: &[u8], node: &Node<'_>, sink: &mut Sink) -> Option<Vec<u8>> {
    let len = reported(length_prefix(bytes.len()), node, sink)?;

    Some([len.as_slice(), bytes].concat())
}

fn length_prefix(len: usize) -> Result<[u8; 4], String> {
    u32::try_from(len).map(u32::to_le_bytes).map_err(|_| format!("{len} items do not fit a borsh length"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn encoded(value: serde_json::Value, base: BaseType, array: bool) -> Option<Vec<u8>> {
        encode(&Node::root(&value), ValueType { base, array }, &mut Sink::default())
    }

    #[test]
    fn writes_each_type_in_borsh() {
        assert_eq!(encoded(json!("258"), BaseType::U16, false), Some(vec![2, 1]));
        assert_eq!(encoded(json!(258), BaseType::U16, false), Some(vec![2, 1]));
        assert_eq!(encoded(json!(-1), BaseType::I8, false), Some(vec![0xff]));
        assert_eq!(encoded(json!(true), BaseType::Bool, false), Some(vec![1]));
        assert_eq!(encoded(json!("hi"), BaseType::String, false), Some(vec![2, 0, 0, 0, b'h', b'i']));
        assert_eq!(encoded(json!("0aff"), BaseType::Bytes, false), Some(vec![2, 0, 0, 0, 0x0a, 0xff]));
        assert_eq!(encoded(json!([1, 2]), BaseType::U8, true), Some(vec![2, 0, 0, 0, 1, 2]));
        assert_eq!(encoded(json!("11111111111111111111111111111111"), BaseType::Mint, false), Some(vec![0; 32]));
    }

    #[test]
    fn refuses_a_value_that_does_not_fit() {
        let mut sink = Sink::default();
        let value = json!(1.5);

        assert_eq!(encode(&Node::root(&value), ValueType { base: BaseType::U64, array: false }, &mut sink), None);
        assert_eq!(
            sink.into_diagnostics().first().unwrap().message,
            "`1.5` is not an integer, and `u64` holds integers"
        );

        assert_eq!(encoded(json!("256"), BaseType::U8, false), None);
    }
}
