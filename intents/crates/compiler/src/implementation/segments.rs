//! Data segments and seeds: `{ "value": "…", "encoding": "…" }` or `{ "read": { … } }`.

use sdp_intents_spec::wire::SegmentV1;
use sdp_intents_spec::{BaseType, Encoding, Segment, ValueRef};

use super::accounts::read_integer;
use super::Build;
use crate::diagnostic::{Code, Diagnostic};
use crate::encoding::{self, fits, literal_bytes, EncodingName, Shape};
use crate::envelope::reported;
use crate::reader::{list, Node};
use crate::reference::{parse_value, ValueText};
use crate::scope::{Allowed, Names};
use crate::suggest::closest;

impl Build<'_, '_> {
    /// `visible` is how many accounts the segment can name: the accounts before a PDA, or every
    /// account for instruction data. Only a builder call can name `{builder.bumps}`.
    pub(super) fn read_segment(&mut self, node: &Node<'_>, visible: usize, builder_call: bool) -> Option<SegmentV1> {
        let mut object = node.object(self.sink)?;

        if let Some(read) = object.field("read") {
            object.finish(self.sink);

            return self.read_account_bytes(&read, visible);
        }

        let value = object.required("value", self.sink);
        let encoding = object.required("encoding", self.sink).and_then(|encoding| self.read_encoding(&encoding));
        object.finish(self.sink);

        let (value, encoding) = (value?, encoding?);
        let text = value.str(self.sink)?;

        match reported(parse_value(text), &value, self.sink)? {
            ValueText::Literal(literal) => {
                let bytes = reported(literal_bytes(encoding.name, &literal), &value, self.sink)?;

                Some(SegmentV1::new(Segment::Literal(self.pool.add(&bytes))))
            }
            ValueText::Reference(reference) => {
                let names = Names::new(
                    self.schema,
                    self.account_names.get(..visible).unwrap_or_default(),
                    Allowed { payers: true, accounts: true, builder: builder_call },
                );
                let resolved = names.resolve(reference, &value.pointer, self.sink)?;
                let wire = self.check_fit(&encoding, resolved.shape, text)?;

                Some(SegmentV1::new(Segment::Reference {
                    value: ValueRef::try_from(resolved.value).ok()?,
                    encoding: wire,
                }))
            }
        }
    }

    /// `{ "account": "{accounts.mint}", "owner": "…", "offset": "44", "length": "1" }`.
    fn read_account_bytes(&mut self, node: &Node<'_>, visible: usize) -> Option<SegmentV1> {
        let mut object = node.object(self.sink)?;
        let account =
            object.required("account", self.sink).and_then(|account| self.read_account_index(&account, visible));
        let owner = object.required("owner", self.sink).and_then(|owner| self.read_literal_address(&owner));
        let offset = object.required("offset", self.sink).and_then(|offset| read_integer(&offset, self.sink));
        let length_node = object.required("length", self.sink);
        let length: Option<u8> = length_node.as_ref().and_then(|length| read_integer(length, self.sink));
        object.finish(self.sink);

        if let (Some(length), Some(node)) = (length, &length_node) {
            if length > 32 {
                self.sink.push(
                    Diagnostic::new(
                        Code::InvalidValue,
                        &node.pointer,
                        format!("{length} bytes, and a read is at most 32"),
                    )
                    .help("a record that reads more uses a builder program"),
                );
                return None;
            }
        }

        Some(SegmentV1::new(Segment::AccountBytes {
            account: account?,
            owner: owner?,
            offset: offset?,
            length: length?,
        }))
    }

    fn read_encoding(&mut self, node: &Node<'_>) -> Option<NamedEncoding> {
        let text = node.str(self.sink)?;
        let names: Vec<&str> = encoding::NAMES.iter().map(|(name, _)| *name).collect();

        let Some(name) = encoding::parse(text) else {
            let diagnostic =
                Diagnostic::new(Code::UnknownEncoding, &node.pointer, format!("`{text}` is not an encoding"));

            self.sink.push(match closest(text, names.iter().copied()) {
                Some(known) => diagnostic.help(format!("did you mean `{known}`?")),
                None => diagnostic.help(format!("the encodings are {}", list(&names))),
            });

            return None;
        };

        Some(NamedEncoding { name, text: text.to_owned(), pointer: node.pointer.clone() })
    }

    /// An encoding must hold every value of the reference's type. The finding names the encoding
    /// that fits.
    fn check_fit(&mut self, encoding: &NamedEncoding, shape: Shape, reference: &str) -> Option<Encoding> {
        let EncodingName::Wire(wire) = encoding.name else {
            self.sink.push(
                Diagnostic::new(Code::EncodingMismatch, &encoding.pointer, "`hex` is only for literals")
                    .help(format!("use `{}` for `{reference}`", fitting(shape))),
            );
            return None;
        };

        if !fits(wire, shape) {
            let kind = describe(shape);

            self.sink.push(
                Diagnostic::new(
                    Code::EncodingMismatch,
                    &encoding.pointer,
                    format!("`{}` cannot hold every value of `{reference}`, which is {kind}", encoding.text),
                )
                .help(format!("use `{}`", fitting(shape))),
            );

            return None;
        }

        Some(wire)
    }
}

struct NamedEncoding {
    name: EncodingName,
    text: String,
    pointer: String,
}

/// The encoding that holds every value of `shape` with no extra bytes.
fn fitting(shape: Shape) -> &'static str {
    if shape.optional || shape.value_type.array {
        return "borsh";
    }

    match shape.value_type.base {
        BaseType::U8 => "u8",
        BaseType::U16 => "u16le",
        BaseType::U32 => "u32le",
        BaseType::U64 => "u64le",
        BaseType::U128 => "u128le",
        BaseType::I8 => "i8",
        BaseType::I16 => "i16le",
        BaseType::I32 => "i32le",
        BaseType::I64 => "i64le",
        BaseType::I128 => "i128le",
        BaseType::Bool => "bool",
        BaseType::Address | BaseType::Mint => "address",
        BaseType::String => "utf8",
        BaseType::Bytes => "borsh",
    }
}

fn describe(shape: Shape) -> String {
    let base = crate::value_type::name(shape.value_type.base);

    match (shape.optional, shape.value_type.array) {
        (true, _) => format!("an optional `{base}`"),
        (false, true) => format!("an array of `{base}`"),
        (false, false) => format!("a `{base}`"),
    }
}
