//! Compiles an interface: its inputs and outputs, its display, and its post conditions.

use sdp_intents_spec::{
    BaseType, DocumentIdV1, DocumentKind, InputV1, Interface, InterfaceDocV1, LiteralV1, OutputV1, PostConditionV1,
    SemverV1, ValueRefV1, ValueType,
};
use serde_json::Value;

use crate::catalog::Catalog;
use crate::diagnostic::{Code, Diagnostic, Report};
use crate::encoding::Shape;
use crate::envelope::{parse_json, read_envelope, root, Envelope};
use crate::id::Id;
use crate::limits;
use crate::post_condition::{read_post_condition, Output};
use crate::reader::{Node, Object, Sink};
use crate::reference::{parse_value, ValueText};
use crate::scope::{Allowed, Field, Names, Schema};
use crate::template::compile_template;
use crate::value_type::read_value_type;
use crate::writer::{AddressTable, Pool, Writer};

/// An interface in binary form, with the schema that its implementations compile against.
#[derive(Clone, Debug)]
pub struct CompiledInterface {
    pub id: Id,
    pub version: SemverV1,
    pub document_id: DocumentIdV1,
    pub schema: Schema,
    pub bytes: Vec<u8>,
}

pub fn compile_interface(text: &str, catalog: &Catalog) -> Result<CompiledInterface, Report> {
    let value = parse_json(text)?;
    let mut build = Build::default();
    let compiled = build.interface(&value, catalog);

    match compiled {
        Some(compiled) if build.sink.is_empty() => Ok(compiled),
        _ => Err(Report { diagnostics: build.sink.into_diagnostics(), syntax: None }),
    }
}

/// An input as JSON states it. The mint of its amount display is resolved once every input and
/// output is known.
struct InputDraft<'v> {
    field: Field,
    name_node: Node<'v>,
    signer: bool,
    amount_mint: Option<Node<'v>>,
    /// The input's type has a finding. The draft keeps its place, so later inputs keep their
    /// indexes, and references to it add no second finding.
    failed: bool,
}

/// Stands in for the type of an input whose type has a finding. No document is written with it.
const PLACEHOLDER: ValueType = ValueType { base: BaseType::Bytes, array: false };

#[derive(Default)]
struct Build {
    sink: Sink,
    pool: Pool,
    addresses: AddressTable,
}

impl Build {
    fn interface(&mut self, value: &Value, catalog: &Catalog) -> Option<CompiledInterface> {
        let mut object = root(value, &mut self.sink)?;
        let envelope = read_envelope(&mut object, "interface", catalog, &mut self.sink);

        let drafts = self.inputs(&mut object);
        let outputs = self.outputs(&mut object);
        let schema = Schema { inputs: drafts.iter().map(|draft| draft.field.clone()).collect(), outputs };
        let failed: Vec<String> =
            drafts.iter().filter(|draft| draft.failed).map(|draft| draft.field.name.clone()).collect();
        let names = Names { failed: &failed, ..Names::new(&schema, &[], Allowed { payers: false, accounts: false }) };

        let display = object
            .required("display", &mut self.sink)
            .and_then(|display| compile_template(&display, &names, &mut self.sink));
        let inputs: Vec<InputV1> = drafts.iter().map(|draft| self.encode_input(draft, &names)).collect();
        let post_conditions = self.post_conditions(&mut object, &names);

        let pointer = object.pointer().to_owned();
        object.finish(&mut self.sink);
        limits::check(&mut self.sink, &pointer, "inputs", inputs.len(), limits::INPUTS);
        limits::check(&mut self.sink, &pointer, "outputs", schema.outputs.len(), limits::OUTPUTS);
        limits::check(&mut self.sink, &pointer, "post conditions", post_conditions.len(), limits::POST_CONDITIONS);

        let envelope = envelope?;
        let display = display?;

        if !self.sink.is_empty() {
            return None;
        }

        let document = Document {
            display: &display,
            inputs: &inputs,
            outputs: &schema.outputs,
            post_conditions: &post_conditions,
        };
        let bytes = self.write(&envelope, document)?;

        Some(CompiledInterface {
            id: envelope.id,
            version: envelope.version,
            document_id: envelope.document_id,
            schema,
            bytes,
        })
    }

    fn inputs<'v>(&mut self, object: &mut Object<'v>) -> Vec<InputDraft<'v>> {
        let nodes = object.required("inputs", &mut self.sink).and_then(|inputs| inputs.array(&mut self.sink));
        let drafts: Vec<InputDraft<'v>> =
            nodes.unwrap_or_default().iter().filter_map(|input| read_input(input, &mut self.sink)).collect();

        check_unique(drafts.iter().map(|draft| (draft.field.name.as_str(), &draft.name_node)), &mut self.sink);
        drafts
    }

    fn outputs(&mut self, object: &mut Object<'_>) -> Vec<Field> {
        let nodes = object.field("outputs").and_then(|outputs| outputs.array(&mut self.sink)).unwrap_or_default();
        let outputs: Vec<Field> = nodes.iter().filter_map(|output| read_output(output, &mut self.sink)).collect();

        check_unique(outputs.iter().map(|output| output.name.as_str()).zip(nodes.iter()), &mut self.sink);
        outputs
    }

    fn post_conditions(&mut self, object: &mut Object<'_>, names: &Names<'_>) -> Vec<PostConditionV1> {
        let nodes =
            object.field("postConditions").and_then(|conditions| conditions.array(&mut self.sink)).unwrap_or_default();

        nodes
            .iter()
            .filter_map(|condition| {
                let output = Output { pool: &mut self.pool, addresses: &mut self.addresses };

                read_post_condition(condition, names, false, output, &mut self.sink)
            })
            .collect()
    }

    fn encode_input(&mut self, draft: &InputDraft<'_>, names: &Names<'_>) -> InputV1 {
        let amount_mint =
            draft.amount_mint.as_ref().and_then(|mint| resolve_amount_mint(draft, mint, names, &mut self.sink));

        InputV1::new(
            self.pool.add(draft.field.name.as_bytes()),
            draft.field.shape.value_type,
            draft.signer,
            draft.field.shape.optional,
            amount_mint.unwrap_or_default(),
        )
    }

    fn write(&mut self, envelope: &Envelope, document: Document<'_>) -> Option<Vec<u8>> {
        let name = self.pool.add(envelope.id.name.as_bytes());
        let display = self.pool.add(document.display);
        let outputs: Vec<OutputV1> = document
            .outputs
            .iter()
            .map(|output| OutputV1 {
                name: self.pool.add(output.name.as_bytes()),
                value_type: output.shape.value_type.into(),
            })
            .collect();
        limits::check(&mut self.sink, "", "bytes in the pool", self.pool.len(), limits::POOL_BYTES);

        let mut writer = Writer::new::<InterfaceDocV1>();
        let fixed = InterfaceDocV1 {
            id: envelope.document_id,
            name,
            display,
            inputs: writer.table(document.inputs),
            outputs: writer.table(&outputs),
            post_conditions: writer.table(document.post_conditions),
            addresses: writer.table(self.addresses.as_slice()),
            literals: writer.table::<LiteralV1>(&[]),
            pool: writer.pool(&self.pool),
            ..InterfaceDocV1::default()
        };
        let header = writer.header(DocumentKind::Interface);
        let bytes = writer.finish(&InterfaceDocV1 { header, ..fixed });
        limits::check(&mut self.sink, "", "bytes in the document", bytes.len(), limits::DOCUMENT_BYTES);

        if let Err(error) = Interface::parse(&bytes) {
            self.sink.push(Diagnostic::new(
                Code::Internal,
                "",
                format!("the compiled interface does not parse: {error}"),
            ));
        }

        self.sink.is_empty().then_some(bytes)
    }
}

/// The parts of an interface that `write` lays out.
#[derive(Clone, Copy)]
struct Document<'d> {
    display: &'d [u8],
    inputs: &'d [InputV1],
    outputs: &'d [Field],
    post_conditions: &'d [PostConditionV1],
}

fn read_input<'v>(node: &Node<'v>, sink: &mut Sink) -> Option<InputDraft<'v>> {
    let mut object = node.object(sink)?;
    let name_node = object.required("name", sink);
    let name = name_node.as_ref().and_then(|name| name.str(sink)).map(str::to_owned);
    let value_type = object.required("type", sink).and_then(|value_type| read_value_type(&value_type, sink));
    let signer = object.field("signer").and_then(|signer| signer.bool(sink)).unwrap_or(false);
    let optional = object.field("optional").and_then(|optional| optional.bool(sink)).unwrap_or(false);
    let amount_mint = object.field("display").and_then(|display| read_display(&display, sink));
    object.finish(sink);

    Some(InputDraft {
        field: Field { name: name?, shape: Shape { value_type: value_type.unwrap_or(PLACEHOLDER), optional } },
        name_node: name_node?,
        signer,
        amount_mint,
        failed: value_type.is_none(),
    })
}

/// `{ "amount": { "mint": "{inputs.mint}" } }`.
fn read_display<'v>(node: &Node<'v>, sink: &mut Sink) -> Option<Node<'v>> {
    let mut display = node.object(sink)?;
    let amount = display.required("amount", sink);
    display.finish(sink);

    let mut amount = amount?.object(sink)?;
    let mint = amount.required("mint", sink);
    amount.finish(sink);

    mint
}

fn read_output(node: &Node<'_>, sink: &mut Sink) -> Option<Field> {
    let mut object = node.object(sink)?;
    let name = object.required("name", sink).and_then(|name| name.str(sink).map(str::to_owned));
    let value_type = object.required("type", sink).and_then(|value_type| read_value_type(&value_type, sink));
    object.finish(sink);

    Some(Field { name: name?, shape: Shape { value_type: value_type?, optional: false } })
}

/// The display places the decimal point with the mint's decimals, so the input must be an
/// unsigned integer and the reference must name a mint.
fn resolve_amount_mint(
    draft: &InputDraft<'_>,
    mint: &Node<'_>,
    names: &Names<'_>,
    sink: &mut Sink,
) -> Option<ValueRefV1> {
    let reference = match parse_value(mint.str(sink)?) {
        Ok(ValueText::Reference(reference)) => reference,
        Ok(ValueText::Literal(_)) => {
            sink.push(
                Diagnostic::new(Code::InvalidValue, &mint.pointer, "the mint of an amount display must be a reference")
                    .help("name a mint input or output, such as `{inputs.mint}`"),
            );
            return None;
        }
        Err(reason) => {
            sink.push(Diagnostic::new(Code::BadTemplate, &mint.pointer, reason));
            return None;
        }
    };

    let resolved = names.resolve(reference, &mint.pointer, sink)?;
    let input_type = draft.field.shape.value_type;

    if resolved.shape.value_type != (ValueType { base: BaseType::Mint, array: false }) {
        sink.push(Diagnostic::new(
            Code::InvalidValue,
            &mint.pointer,
            "the mint of an amount display must name a `mint`",
        ));
        return None;
    }

    let unsigned =
        matches!(input_type.base, BaseType::U8 | BaseType::U16 | BaseType::U32 | BaseType::U64 | BaseType::U128);

    if input_type.array || !unsigned {
        sink.push(Diagnostic::new(
            Code::InvalidValue,
            &draft.name_node.pointer,
            "an amount display needs an unsigned integer input",
        ));
        return None;
    }

    Some(resolved.value)
}

/// Adds a finding for each name that an earlier entry already uses.
pub fn check_unique<'n, 'v: 'n>(names: impl Iterator<Item = (&'n str, &'n Node<'v>)>, sink: &mut Sink) {
    let mut seen: Vec<&str> = Vec::new();

    names.for_each(|(name, node)| {
        if seen.contains(&name) {
            sink.push(Diagnostic::new(
                Code::DuplicateName,
                &node.pointer,
                format!("the name `{name}` is already used"),
            ));
        }

        seen.push(name);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{edit, publishers, TOKEN_TRANSFER};
    use crate::Code;

    #[test]
    fn compiles_token_transfer() {
        let compiled = compile_interface(TOKEN_TRANSFER, &publishers()).unwrap();
        let interface = Interface::parse(&compiled.bytes).unwrap();

        assert_eq!(interface.name().unwrap(), b"token.transfer");
        assert_eq!(interface.display().unwrap(), b"Send {i3} {i2} to {i1}");
        assert_eq!(interface.inputs().unwrap().len(), 5);
        assert_eq!(interface.post_conditions().unwrap().len(), 2);
        assert_eq!(
            compiled.schema.inputs.iter().map(|input| input.name.as_str()).collect::<Vec<_>>(),
            ["from", "to", "mint", "amount", "memo"]
        );
    }

    #[test]
    fn suggests_a_value_type_for_a_typo() {
        let text = edit(TOKEN_TRANSFER, r#""type": "mint""#, r#""type": "mnit""#);
        let report = compile_interface(&text, &publishers()).unwrap_err();

        assert_eq!(report.codes(), [Code::InvalidValue]);
        assert!(report.render("token.transfer/1.0.0.json", &text).contains("did you mean `mint`?"));
    }

    #[test]
    fn an_amount_display_must_name_a_mint() {
        let text = edit(TOKEN_TRANSFER, r#""mint": "{inputs.mint}" } }"#, r#""mint": "{inputs.to}" } }"#);
        let report = compile_interface(&text, &publishers()).unwrap_err();

        assert_eq!(report.diagnostics.first().unwrap().pointer, "/inputs/3/display/amount/mint");
    }

    #[test]
    fn an_interface_cannot_state_invokes_only() {
        let text =
            edit(TOKEN_TRANSFER, r#"{ "noOtherOutflows": { "from": "{inputs.from}" },"#, r#"{ "invokesOnly": [],"#);
        let report = compile_interface(&text, &publishers()).unwrap_err();

        assert_eq!(report.codes(), [Code::InvalidValue]);
    }
}
