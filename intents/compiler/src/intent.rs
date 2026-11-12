//! Compiles an intent: pins the interface and the implementation to the versions in the catalog,
//! and writes each input in borsh, in interface order.
//!
//! `cluster` is checked and not stored, because the binary form of a record has no cluster either.
//! The registry that holds the record is on one cluster.

use sdp_intents_spec::wire::{DocumentKind, IntentDocV1, PodU64, PoolRefV1};
use sdp_intents_spec::{Address, BaseType, Intent, IntentOptions, ValueType};
use serde_json::Value;

use crate::borsh::encode;
use crate::catalog::Catalog;
use crate::diagnostic::{Code, Diagnostic, Report};
use crate::encoding::address;
use crate::envelope::{parse_json, read_kind, reported, root};
use crate::id::caret_covers;
use crate::implementation::CompiledImplementation;
use crate::interface::CompiledInterface;
use crate::limits;
use crate::reader::{Node, Object, Sink};
use crate::resolve::{read_implementation, read_interface, InterfaceMatch};
use crate::scope::{Field, Schema};
use crate::writer::{Pool, Writer};

/// An intent in binary form, with the documents of the catalog that it names.
#[derive(Clone, Debug)]
pub struct CompiledIntent<'c> {
    pub bytes: Vec<u8>,
    pub interface: &'c CompiledInterface,
    pub implementation: &'c CompiledImplementation,
}

pub(crate) fn compile_intent<'c>(text: &str, catalog: &'c Catalog) -> Result<CompiledIntent<'c>, Report> {
    let value = parse_json(text)?;
    let mut sink = Sink::default();
    let compiled = compile(&value, catalog, &mut sink);

    match compiled {
        Some(compiled) if sink.is_empty() => Ok(compiled),
        _ => Err(Report { diagnostics: sink.into_diagnostics(), syntax: None }),
    }
}

struct Payers {
    fee: Address,
    rent: Address,
}

#[derive(Default)]
struct Options {
    priority_fee_lamports: u64,
    flags: IntentOptions,
}

fn compile<'c>(value: &Value, catalog: &'c Catalog, sink: &mut Sink) -> Option<CompiledIntent<'c>> {
    let mut object = root(value, sink)?;
    read_kind(&mut object, "intent", sink);

    let interface = object.required("interface", sink).and_then(|node| read_interface(&node, catalog, sink));
    let implementation_node = object.required("implementation", sink);
    let implementation = implementation_node.as_ref().and_then(|node| read_implementation(node, catalog, sink));

    if let (Some(interface), Some(implementation), Some(node)) = (&interface, implementation, &implementation_node) {
        check_implements(interface, implementation, node, sink);
    }

    let inputs = object.required("inputs", sink);
    let inputs =
        interface.as_ref().zip(inputs).and_then(|(found, node)| read_inputs(&node, &found.interface.schema, sink));
    let payers = object.required("payers", sink).and_then(|node| read_payers(&node, sink));
    let options = object.field("options").map_or(Some(Options::default()), |node| read_options(&node, sink));

    if let Some(cluster) = object.field("cluster") {
        cluster.str(sink).and_then(|text| reported(address(text), &cluster, sink));
    }

    object.finish(sink);

    let interface = interface?.interface;
    let implementation = implementation?;
    let fixed = IntentDocV1 {
        interface: interface.document_id,
        implementation: implementation.document_id,
        fee_payer: payers.as_ref()?.fee,
        rent_payer: payers?.rent,
        priority_fee_lamports: PodU64::new(options.as_ref()?.priority_fee_lamports),
        flags: options?.flags.to_flags(),
        ..IntentDocV1::default()
    };

    let bytes = sink.is_empty().then(|| write(fixed, &inputs?, sink)).flatten()?;

    Some(CompiledIntent { bytes, interface, implementation })
}

/// The implementation must implement this interface, at a version that the interface still covers.
fn check_implements(
    interface: &InterfaceMatch<'_>,
    implementation: &CompiledImplementation,
    node: &Node<'_>,
    sink: &mut Sink,
) {
    let defined = interface.interface.document_id;
    let implements = implementation.implements;
    let same_interface = implements.publisher == defined.publisher && implements.name_hash == defined.name_hash;

    if !same_interface || !caret_covers(implements.version, defined.version) {
        sink.push(Diagnostic::new(
            Code::InvalidValue,
            &node.pointer,
            format!("`{}` does not implement `{}` at this version", implementation.id, interface.interface.id),
        ));
    }
}

fn read_inputs(node: &Node<'_>, schema: &Schema, sink: &mut Sink) -> Option<Vec<Vec<u8>>> {
    let mut object = node.object(sink)?;
    let inputs: Vec<Option<Vec<u8>>> =
        schema.inputs.iter().map(|field| read_input(&mut object, field, &node.pointer, sink)).collect();
    object.finish(sink);

    inputs.into_iter().collect()
}

/// An optional input is `null` or left out when it is absent, and its borsh starts with the tag.
fn read_input(object: &mut Object<'_>, field: &Field, pointer: &str, sink: &mut Sink) -> Option<Vec<u8>> {
    let optional = field.shape.optional;
    let value = object.field(&field.name).filter(|value| !(optional && value.value.is_null()));

    match value {
        Some(value) if optional => {
            encode(&value, field.shape.value_type, sink).map(|bytes| [&[1], &bytes[..]].concat())
        }
        Some(value) => encode(&value, field.shape.value_type, sink),
        None if optional => Some(vec![0]),
        None => {
            sink.push(Diagnostic::new(Code::MissingKey, pointer, format!("missing the input `{}`", field.name)));

            None
        }
    }
}

/// `rent` defaults to `fee`.
fn read_payers(node: &Node<'_>, sink: &mut Sink) -> Option<Payers> {
    let mut object = node.object(sink)?;
    let read = |node: Node<'_>, sink: &mut Sink| node.str(sink).and_then(|text| reported(address(text), &node, sink));

    let fee = object.required("fee", sink).and_then(|node| read(node, sink)).map(Address);
    let rent = object.field("rent").map(|node| read(node, sink).map(Address));
    object.finish(sink);

    let fee = fee?;

    Some(Payers { fee, rent: rent.unwrap_or(Some(fee))? })
}

fn read_options(node: &Node<'_>, sink: &mut Sink) -> Option<Options> {
    let mut object = node.object(sink)?;
    let defaults = IntentOptions::default();
    let flag =
        |node: Option<Node<'_>>, default: bool, sink: &mut Sink| node.map_or(Some(default), |node| node.bool(sink));

    let priority_fee = object.field("priorityFeeLamports").map_or(Some(0), |node| read_lamports(&node, sink));
    let allow_unapproved = flag(object.field("allowUnapproved"), defaults.allow_unapproved, sink);
    let assertions = flag(object.field("assertions"), defaults.assertions, sink);
    let verify_intent = flag(object.field("verifyIntent"), defaults.verify_intent, sink);
    object.finish(sink);

    Some(Options {
        priority_fee_lamports: priority_fee?,
        flags: IntentOptions {
            allow_unapproved: allow_unapproved?,
            assertions: assertions?,
            verify_intent: verify_intent?,
        },
    })
}

fn read_lamports(node: &Node<'_>, sink: &mut Sink) -> Option<u64> {
    let bytes = encode(node, ValueType { base: BaseType::U64, array: false }, sink)?;

    bytes.try_into().ok().map(u64::from_le_bytes)
}

fn write(fixed: IntentDocV1, inputs: &[Vec<u8>], sink: &mut Sink) -> Option<Vec<u8>> {
    let mut pool = Pool::default();
    let ranges: Vec<PoolRefV1> = inputs.iter().map(|input| pool.add(input)).collect();
    limits::check(sink, "/inputs", "bytes of inputs", pool.len(), limits::POOL_BYTES);

    let mut writer = Writer::new::<IntentDocV1>();
    let fixed = IntentDocV1 { inputs: writer.table(&ranges), pool: writer.pool(&pool), ..fixed };
    let header = writer.header(DocumentKind::Intent);
    let bytes = writer.finish(&IntentDocV1 { header, ..fixed });

    if let Err(error) = Intent::parse(&bytes) {
        sink.push(Diagnostic::new(Code::Internal, "", format!("the compiled intent does not parse: {error}")));
    }

    sink.is_empty().then_some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{edit, full_catalog, INTENT_SPL_TRANSFER};

    #[test]
    fn writes_each_input_in_interface_order() {
        let bytes = compile_intent(INTENT_SPL_TRANSFER, &full_catalog()).unwrap().bytes;
        let intent = Intent::parse(&bytes).unwrap();

        assert_eq!(intent.inputs().unwrap().len(), 5);
        assert_eq!(intent.input(3).unwrap(), 100_000_000u64.to_le_bytes());
        assert_eq!(intent.input(4).unwrap(), [0]);
        assert_eq!(intent.fee_payer(), intent.rent_payer());
        assert_eq!(intent.priority_fee_lamports(), 5_000);
        assert_eq!(intent.implementation().version.major.get(), 1);
    }

    #[test]
    fn names_the_input_that_a_typo_meant() {
        let text = edit(INTENT_SPL_TRANSFER, r#""amount": "100000000""#, r#""amout": "100000000""#);
        let report = compile_intent(&text, &full_catalog()).unwrap_err();

        assert_eq!(report.codes(), [Code::MissingKey, Code::UnknownKey]);
        assert_eq!(report.diagnostics.get(1).unwrap().help.as_deref(), Some("did you mean `amount`?"));
    }

    #[test]
    fn a_memo_is_an_optional_string() {
        let text = edit(INTENT_SPL_TRANSFER, r#""memo": null"#, r#""memo": "hi""#);
        let bytes = compile_intent(&text, &full_catalog()).unwrap().bytes;

        assert_eq!(Intent::parse(&bytes).unwrap().input(4).unwrap(), [1, 2, 0, 0, 0, b'h', b'i']);
    }

    #[test]
    fn refuses_an_implementation_of_another_interface_version() {
        let text = edit(INTENT_SPL_TRANSFER, "solana.org/spl-token-transfer@^1", "solana.org/spl-token-transfer@^2");
        let report = compile_intent(&text, &full_catalog()).unwrap_err();

        assert_eq!(report.codes(), [Code::VersionMismatch]);
    }
}
