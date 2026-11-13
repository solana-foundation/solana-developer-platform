//! Compiles a template to its binary text: each reference becomes a position, such as `{i3}` for
//! input 3, and literal braces stay escaped.

use sdp_intents_spec::ValueSource;

use crate::diagnostic::{Code, Diagnostic};
use crate::limits;
use crate::reader::{Node, Sink};
use crate::reference::{parse_template, TemplatePart};
use crate::scope::Names;

pub fn compile_template(node: &Node<'_>, names: &Names<'_>, sink: &mut Sink) -> Option<Vec<u8>> {
    let text = node.str(sink)?;
    let parts = match parse_template(text) {
        Ok(parts) => parts,
        Err(reason) => {
            sink.push(Diagnostic::new(Code::BadTemplate, &node.pointer, reason));

            return None;
        }
    };

    // Resolve every part before joining them, so that each unknown reference gets a finding.
    let compiled: Option<String> = parts
        .iter()
        .map(|part| match part {
            TemplatePart::Text(text) => Some(text.replace('{', "{{").replace('}', "}}")),
            TemplatePart::Reference(reference) => {
                let resolved = names.resolve(*reference, &node.pointer, sink)?;
                let letter = match ValueSource::try_from(resolved.value.source).ok()? {
                    ValueSource::Input => 'i',
                    ValueSource::Output => 'o',
                    ValueSource::Payer => 'p',
                    _ => 'a',
                };

                Some(format!("{{{letter}{}}}", resolved.value.index))
            }
        })
        .collect::<Vec<_>>()
        .into_iter()
        .collect();

    let compiled = compiled?.into_bytes();
    limits::check(sink, &node.pointer, "bytes in the compiled template", compiled.len(), limits::TEMPLATE_BYTES);

    Some(compiled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoding::Shape;
    use crate::scope::{Allowed, Field, Schema};
    use sdp_intents_spec::{BaseType, ValueType};
    use serde_json::json;

    #[test]
    fn rewrites_references_to_positions() {
        let field = |name: &str| Field {
            name: name.to_owned(),
            shape: Shape { value_type: ValueType { base: BaseType::Address, array: false }, optional: false },
        };
        let schema = Schema { inputs: vec![field("from"), field("to")], outputs: Vec::new() };
        let names = Names::new(&schema, &[], Allowed { payers: false, accounts: false });
        let mut sink = Sink::default();

        let value = json!("Send to {inputs.to} {{not a reference}}");
        let compiled = compile_template(&Node::root(&value), &names, &mut sink).unwrap();

        assert_eq!(compiled, b"Send to {i1} {{not a reference}}".to_vec());
        assert!(sink.is_empty());
    }
}
