use sdp_intents_spec::{BaseType, ValueType};

use crate::diagnostic::{Code, Diagnostic};
use crate::reader::{list, Node, Sink};
use crate::suggest::closest;

const NAMES: [(&str, BaseType); 15] = [
    ("u8", BaseType::U8),
    ("u16", BaseType::U16),
    ("u32", BaseType::U32),
    ("u64", BaseType::U64),
    ("u128", BaseType::U128),
    ("i8", BaseType::I8),
    ("i16", BaseType::I16),
    ("i32", BaseType::I32),
    ("i64", BaseType::I64),
    ("i128", BaseType::I128),
    ("bool", BaseType::Bool),
    ("address", BaseType::Address),
    ("mint", BaseType::Mint),
    ("string", BaseType::String),
    ("bytes", BaseType::Bytes),
];

/// Reads `"u64"` or `{ "array": "u64" }`.
pub fn read_value_type(node: &Node<'_>, sink: &mut Sink) -> Option<ValueType> {
    if !node.is_object() {
        return read_base(node, sink).map(|base| ValueType { base, array: false });
    }

    let mut object = node.object(sink)?;
    let element = object.required("array", sink);
    object.finish(sink);

    element.and_then(|element| read_base(&element, sink)).map(|base| ValueType { base, array: true })
}

pub fn name(base: BaseType) -> &'static str {
    NAMES.iter().find(|(_, known)| *known == base).map_or("unknown", |(name, _)| name)
}

fn read_base(node: &Node<'_>, sink: &mut Sink) -> Option<BaseType> {
    let text = node.str(sink)?;
    let found = NAMES.iter().find(|(name, _)| *name == text).map(|(_, base)| *base);

    if found.is_none() {
        let names: Vec<&str> = NAMES.iter().map(|(name, _)| *name).collect();
        let diagnostic = Diagnostic::new(Code::InvalidValue, &node.pointer, format!("`{text}` is not a value type"));

        sink.push(match closest(text, names.iter().copied()) {
            Some(known) => diagnostic.help(format!("did you mean `{known}`?")),
            None => diagnostic.help(format!("the value types are {}", list(&names))),
        });
    }

    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_scalars_and_arrays() {
        let mut sink = Sink::default();

        assert_eq!(
            read_value_type(&Node::root(&json!("mint")), &mut sink),
            Some(ValueType { base: BaseType::Mint, array: false })
        );
        assert_eq!(
            read_value_type(&Node::root(&json!({ "array": "u64" })), &mut sink),
            Some(ValueType { base: BaseType::U64, array: true })
        );
        assert!(sink.is_empty());
    }

    #[test]
    fn suggests_a_type_for_a_typo() {
        let mut sink = Sink::default();

        assert_eq!(read_value_type(&Node::root(&json!("adress")), &mut sink), None);
        assert_eq!(sink.into_diagnostics().first().unwrap().help.as_deref(), Some("did you mean `address`?"));
    }
}
