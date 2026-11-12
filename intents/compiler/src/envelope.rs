//! The keys that every document starts with: `spec`, `kind`, `id`, and `version`.

use sdp_intents_spec::wire::{DocumentIdV1, SemverV1};
use serde_json::Value;

use crate::catalog::Catalog;
use crate::diagnostic::{Code, Diagnostic, Report, SyntaxError};
use crate::id::{parse_version, Id};
use crate::reader::{list, Node, Object, Sink};

pub const SPEC: &str = "sdp-intents@1.0";

pub struct Envelope {
    pub id: Id,
    pub version: SemverV1,
    pub document_id: DocumentIdV1,
}

/// Parses JSON text. A syntax error becomes a report with the line and column that `serde_json`
/// gives.
pub fn parse_json(text: &str) -> Result<Value, Report> {
    serde_json::from_str(text).map_err(|error| Report {
        diagnostics: Vec::new(),
        syntax: Some(SyntaxError { line: error.line(), column: error.column(), message: error.to_string() }),
    })
}

pub fn read_envelope(object: &mut Object<'_>, kind: &str, catalog: &Catalog, sink: &mut Sink) -> Option<Envelope> {
    object.field("name");
    read_kind(object, kind, sink);

    let id = object.required("id", sink).and_then(|node| reported(Id::parse(node.str(sink)?), &node, sink));
    let version =
        object.required("version", sink).and_then(|node| reported(parse_version(node.str(sink)?), &node, sink));

    let id = id?;
    let version = version?;
    let Some(publisher) = catalog.publisher(&id.organization) else {
        sink.push(
            Diagnostic::new(
                Code::UnknownPublisher,
                &format!("{}/id", object.pointer()),
                format!("the organization `{}` has no address", id.organization),
            )
            .help(format!("the known organizations are {}", list(&catalog.publisher_names()))),
        );

        return None;
    };

    Some(Envelope { document_id: id.document_id(publisher, version), id, version })
}

/// Checks `spec` and `kind`, which every document has.
pub fn read_kind(object: &mut Object<'_>, kind: &str, sink: &mut Sink) {
    if let Some(spec) = object.required("spec", sink) {
        expect_text(&spec, SPEC, sink, "this compiler reads spec version 1.0");
    }

    if let Some(kind_node) = object.required("kind", sink) {
        expect_text(&kind_node, kind, sink, "a file holds one document, of the kind that its folder names");
    }
}

/// Turns a parser's error into a finding at `node`.
pub fn reported<T>(result: Result<T, String>, node: &Node<'_>, sink: &mut Sink) -> Option<T> {
    result.map_err(|reason| sink.push(Diagnostic::new(Code::InvalidValue, &node.pointer, reason))).ok()
}

fn expect_text(node: &Node<'_>, expected: &str, sink: &mut Sink, help: &str) {
    if let Some(text) = node.str(sink) {
        if text != expected {
            sink.push(
                Diagnostic::new(Code::InvalidValue, &node.pointer, format!("expected `{expected}`, found `{text}`"))
                    .help(help),
            );
        }
    }
}

/// Wraps the root of a document.
pub fn root<'v>(value: &'v Value, sink: &mut Sink) -> Option<Object<'v>> {
    Node::root(value).object(sink)
}
