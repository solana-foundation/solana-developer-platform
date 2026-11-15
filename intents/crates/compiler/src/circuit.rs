//! The circuit document (`DESIGN.md`, 4.17): `{ "protocol", "proofSystem", "provingKeys", "module",
//! "sources" }`. A shielded recipe names one at its exact version.

use sdp_intents_spec::wire::{CircuitDocV1, DocumentIdV1, DocumentKind, SemverV1, SPEC_MINOR};
use sdp_intents_spec::{Circuit, ProofSystem, ShieldedProtocol};
use serde_json::Value;

use crate::catalog::Catalog;
use crate::diagnostic::{Code, Diagnostic, Report};
use crate::envelope::{parse_json, read_envelope, root, SPEC_1_1};
use crate::id::Id;
use crate::limits;
use crate::reader::{list, Node, Object, Sink};
use crate::writer::{Pool, Writer};

/// The protocols and proof systems that a circuit can name, by their JSON names.
pub(crate) const PROTOCOLS: [(&str, ShieldedProtocol); 1] = [("privacy-rings", ShieldedProtocol::PrivacyRings)];
pub(crate) const PROOF_SYSTEMS: [(&str, ProofSystem); 1] = [("groth16-bn254", ProofSystem::Groth16Bn254)];

#[derive(Clone, Debug)]
pub struct CompiledCircuit {
    pub id: Id,
    pub version: SemverV1,
    pub document_id: DocumentIdV1,
    pub protocol: ShieldedProtocol,
    pub bytes: Vec<u8>,
}

pub(crate) fn compile_circuit(text: &str, catalog: &Catalog) -> Result<CompiledCircuit, Report> {
    let value = parse_json(text)?;
    let mut sink = Sink::default();
    let compiled = read_circuit(&value, catalog, &mut sink);

    match compiled {
        Some(compiled) if sink.is_empty() => Ok(compiled),
        _ => Err(Report { diagnostics: sink.into_diagnostics(), syntax: None }),
    }
}

fn read_circuit(value: &Value, catalog: &Catalog, sink: &mut Sink) -> Option<CompiledCircuit> {
    let mut object = root(value, sink)?;
    let envelope = read_envelope(&mut object, "circuit", catalog, sink);
    let protocol = object.required("protocol", sink).and_then(|node| named(&node, &PROTOCOLS, "protocol", sink));
    let proof_system =
        object.required("proofSystem", sink).and_then(|node| named(&node, &PROOF_SYSTEMS, "proof system", sink));
    let proving_keys = object.required("provingKeys", sink).and_then(|node| digest(&node, sink));
    let module = object.field("module").map(|node| digest(&node, sink));
    let sources = read_sources(&mut object, sink);
    object.finish(sink);

    let envelope = envelope?;

    if envelope.spec.as_deref() != Some(SPEC_1_1) {
        sink.push(
            Diagnostic::new(Code::InvalidValue, "/spec", "a circuit needs spec 1.1")
                .help(format!("write `\"spec\": \"{SPEC_1_1}\"`")),
        );
    }

    let mut pool = Pool::default();
    let name = pool.add(envelope.id.name.as_bytes());
    let source_refs: Vec<_> = sources?.iter().map(|source| pool.add(source.as_bytes())).collect();
    limits::check(sink, "", "bytes in the pool", pool.len(), limits::POOL_BYTES);

    let mut writer = Writer::new::<CircuitDocV1>();
    let fixed = CircuitDocV1 {
        id: envelope.document_id,
        name,
        protocol: protocol?.into(),
        proof_system: proof_system?.into(),
        proving_keys: proving_keys?,
        module: module.unwrap_or(Some([0; 32]))?,
        sources: writer.table(&source_refs),
        pool: writer.pool(&pool),
        ..CircuitDocV1::default()
    };
    let header =
        sdp_intents_spec::wire::DocumentHeaderV1 { spec_minor: SPEC_MINOR, ..writer.header(DocumentKind::Circuit) };
    let bytes = writer.finish(&CircuitDocV1 { header, ..fixed });

    if let Err(error) = Circuit::parse(&bytes) {
        sink.push(Diagnostic::new(Code::Internal, "", format!("the compiled circuit does not parse: {error}")));
    }

    sink.is_empty().then_some(CompiledCircuit {
        id: envelope.id,
        version: envelope.version,
        document_id: envelope.document_id,
        protocol: protocol?,
        bytes,
    })
}

/// The URLs that serve the keys and the module. A client checks what it fetches by hash, so a
/// source is only where to look.
fn read_sources(object: &mut Object<'_>, sink: &mut Sink) -> Option<Vec<String>> {
    let nodes = object.required("sources", sink).and_then(|sources| sources.array(sink))?;

    nodes.iter().map(|node| node.str(sink).map(str::to_owned)).collect()
}

pub(crate) fn named<T: Copy>(node: &Node<'_>, known: &[(&str, T)], what: &str, sink: &mut Sink) -> Option<T> {
    let name = node.str(sink)?;
    let found = known.iter().find(|(known, _)| *known == name).map(|(_, value)| *value);

    if found.is_none() {
        let names: Vec<&str> = known.iter().map(|(known, _)| *known).collect();
        sink.push(
            Diagnostic::new(Code::InvalidValue, &node.pointer, format!("`{name}` is not a {what}"))
                .help(format!("the {what}s are {}", list(&names))),
        );
    }

    found
}

/// A SHA-256, as 64 hexadecimal digits.
fn digest(node: &Node<'_>, sink: &mut Sink) -> Option<[u8; 32]> {
    let text = node.str(sink)?;
    let bytes: Option<Vec<u8>> = (text.len() == 64)
        .then(|| {
            text.as_bytes()
                .chunks(2)
                .map(|pair| u8::from_str_radix(core::str::from_utf8(pair).ok()?, 16).ok())
                .collect()
        })
        .flatten();
    let digest = bytes.and_then(|bytes| <[u8; 32]>::try_from(bytes).ok());

    if digest.is_none() {
        sink.push(
            Diagnostic::new(Code::InvalidValue, &node.pointer, "this is not a SHA-256")
                .help("write 64 hexadecimal digits"),
        );
    }

    digest
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
