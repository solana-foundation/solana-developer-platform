//! `applies` hints: `{ "account", "owner", "discriminator" }`, `{ "value", "present" }`, and
//! `{ "value", "equals" }`.

use sdp_intents_spec::{AppliesKind, AppliesV1, ValueRefV1};

use super::Build;
use crate::diagnostic::{Code, Diagnostic};
use crate::encoding::{literal_bytes, EncodingName};
use crate::envelope::reported;
use crate::reader::{Node, Object};
use crate::reference::{parse_value, Scope, ValueText};
use crate::scope::{Allowed, Names};

const DISCRIMINATOR_BYTES: usize = 8;

impl Build<'_, '_> {
    pub(super) fn read_applies(&mut self, node: &Node<'_>) {
        let Some(nodes) = node.array(self.sink) else {
            return;
        };

        let hints: Vec<AppliesV1> = nodes.iter().filter_map(|hint| self.read_hint(hint)).collect();
        self.applies.extend(hints);
    }

    fn read_hint(&mut self, node: &Node<'_>) -> Option<AppliesV1> {
        let mut object = node.object(self.sink)?;

        let hint = if object.field("account").is_some() {
            self.read_owner_hint(&mut object)
        } else if object.field("present").is_some() {
            self.read_present_hint(&mut object)
        } else if object.field("equals").is_some() {
            self.read_equals_hint(&mut object)
        } else {
            self.sink.push(
                Diagnostic::new(
                    Code::InvalidValue,
                    &node.pointer,
                    "an `applies` hint checks an account owner or an input",
                )
                .help(
                    "write `{ \"account\", \"owner\" }`, `{ \"value\", \"present\" }`, or `{ \"value\", \"equals\" }`",
                ),
            );
            None
        };
        object.finish(self.sink);

        hint
    }

    fn read_owner_hint(&mut self, object: &mut Object<'_>) -> Option<AppliesV1> {
        let value = object.required("account", self.sink).and_then(|account| self.read_input(&account));
        let owner = object.required("owner", self.sink).and_then(|owner| self.read_literal_address(&owner));
        let discriminator = match object.field("discriminator") {
            Some(node) => Some(self.read_discriminator(&node)?),
            None => Some(Vec::new()),
        };

        let discriminator = discriminator?;
        let mut bytes = [0; DISCRIMINATOR_BYTES];
        bytes.iter_mut().zip(&discriminator).for_each(|(slot, byte)| *slot = *byte);

        Some(AppliesV1 {
            kind: AppliesKind::Owner.into(),
            value: value?,
            owner: owner?,
            discriminator_len: u8::try_from(discriminator.len()).ok()?,
            discriminator: bytes,
        })
    }

    fn read_present_hint(&mut self, object: &mut Object<'_>) -> Option<AppliesV1> {
        let value = object.required("value", self.sink).and_then(|value| self.read_input(&value));
        let present = object.required("present", self.sink).and_then(|present| present.bool(self.sink));
        let kind = if present? { AppliesKind::InputPresent } else { AppliesKind::InputAbsent };

        Some(AppliesV1 { kind: kind.into(), value: value?, ..AppliesV1::default() })
    }

    fn read_equals_hint(&mut self, object: &mut Object<'_>) -> Option<AppliesV1> {
        let value = object.required("value", self.sink).and_then(|value| self.read_input(&value));
        let equals = object.required("equals", self.sink).and_then(|equals| self.read_literal_address(&equals));

        Some(AppliesV1 { kind: AppliesKind::InputEquals.into(), value: value?, owner: equals?, ..AppliesV1::default() })
    }

    /// A hint runs before the recipe, so it can name only inputs.
    fn read_input(&mut self, node: &Node<'_>) -> Option<ValueRefV1> {
        let text = node.str(self.sink)?;

        let reference = match reported(parse_value(text), node, self.sink)? {
            ValueText::Reference(reference) if reference.scope == Scope::Inputs => reference,
            _ => {
                self.sink.push(
                    Diagnostic::new(Code::InvalidValue, &node.pointer, "an `applies` hint can name only an input")
                        .help("name an input, such as `{inputs.mint}`"),
                );
                return None;
            }
        };

        let names = Names::new(self.schema, &[], Allowed { payers: false, accounts: false });

        names.resolve(reference, &node.pointer, self.sink).map(|resolved| resolved.value)
    }

    fn read_discriminator(&mut self, node: &Node<'_>) -> Option<Vec<u8>> {
        let text = node.str(self.sink)?;
        let bytes = reported(literal_bytes(EncodingName::Hex, text), node, self.sink)?;

        if bytes.len() > DISCRIMINATOR_BYTES {
            self.sink.push(Diagnostic::new(
                Code::InvalidValue,
                &node.pointer,
                format!("{} bytes, and a discriminator is at most 8", bytes.len()),
            ));
            return None;
        }

        Some(bytes)
    }
}
