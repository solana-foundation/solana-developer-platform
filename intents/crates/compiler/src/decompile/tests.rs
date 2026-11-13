//! Decompiles every definition in `intents/definitions`, and compiles the JSON again.

use std::fs;
use std::path::Path;

use sdp_intents_spec::wire::DocumentIdV1;
use sdp_intents_spec::{Address, SpecError};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{decompile_implementation, decompile_interface, DecompileError, Organizations};
use crate::Catalog;

const DEFINITIONS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../definitions");

struct Definition {
    path: String,
    text: String,
    bytes: Vec<u8>,
    /// The interface of an implementation.
    implements: Option<DocumentIdV1>,
}

struct Tree {
    interfaces: Vec<Definition>,
    implementations: Vec<Definition>,
}

fn publisher(organization: &str) -> Address {
    Address(Sha256::digest(organization.as_bytes()).into())
}

fn organization_names() -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(DEFINITIONS)
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();

    names.sort();
    names
}

fn organizations() -> Organizations {
    organization_names().into_iter().map(|name| (publisher(&name), name)).collect()
}

fn publishers() -> Catalog {
    organization_names().iter().fold(Catalog::default(), |catalog, name| catalog.with_publisher(name, publisher(name)))
}

struct SourceFile {
    path: String,
    text: String,
}

/// `{organization}/{folder}/{name}/{version}.json`, without the index files.
fn files(folder: &str) -> Vec<SourceFile> {
    let mut files: Vec<SourceFile> = organization_names()
        .iter()
        .flat_map(|organization| {
            let folder = Path::new(DEFINITIONS).join(organization).join(folder);
            fs::read_dir(folder).into_iter().flatten().map(|entry| entry.unwrap().path())
        })
        .flat_map(|document| fs::read_dir(document).unwrap().map(|entry| entry.unwrap().path()))
        .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
        .filter(|path| path.file_name().is_some_and(|name| name != "index.json"))
        .map(|path| {
            let relative = path.strip_prefix(DEFINITIONS).unwrap().to_string_lossy().into_owned();

            SourceFile { path: relative, text: fs::read_to_string(&path).unwrap() }
        })
        .collect();

    files.sort_by(|left, right| left.path.cmp(&right.path));
    files
}

fn compile_tree() -> Tree {
    let mut catalog = publishers();
    let interfaces = files("interfaces")
        .into_iter()
        .map(|SourceFile { path, text }| {
            let bytes = catalog.compile_interface(&text).unwrap().bytes.clone();

            Definition { path, text, bytes, implements: None }
        })
        .collect();

    let implementations = files("implementations")
        .into_iter()
        .map(|SourceFile { path, text }| {
            let compiled = catalog.compile_implementation(&text).unwrap();

            Definition { bytes: compiled.bytes.clone(), implements: Some(compiled.implements), path, text }
        })
        .collect();

    Tree { interfaces, implementations }
}

struct Decompiled<'t> {
    definition: &'t Definition,
    json: Value,
}

impl Tree {
    fn interface_of(&self, implementation: &Definition) -> &[u8] {
        let implements = implementation.implements.unwrap();

        self.interfaces
            .iter()
            .map(|interface| interface.bytes.as_slice())
            .find(|bytes| {
                let id = sdp_intents_spec::Interface::parse(bytes).unwrap().id();

                id.publisher == implements.publisher && id.name_hash == implements.name_hash
            })
            .unwrap()
    }

    fn decompiled(&self) -> Vec<Decompiled<'_>> {
        let organizations = organizations();
        let interfaces = self.interfaces.iter().map(|definition| Decompiled {
            definition,
            json: decompile_interface(&definition.bytes, &organizations).unwrap(),
        });

        let implementations = self.implementations.iter().map(|definition| {
            let interface = self.interface_of(definition);

            Decompiled {
                definition,
                json: decompile_implementation(&definition.bytes, interface, &organizations).unwrap(),
            }
        });

        interfaces.chain(implementations).collect()
    }
}

#[test]
fn every_definition_compiles_back_to_its_bytes() {
    let tree = compile_tree();
    let mut catalog = publishers();

    assert!(!tree.interfaces.is_empty() && !tree.implementations.is_empty());

    for Decompiled { definition, json } in tree.decompiled() {
        let text = serde_json::to_string_pretty(&json).unwrap();
        let compiled = match definition.implements {
            None => catalog.compile_interface(&text).map(|compiled| compiled.bytes.clone()),
            Some(_) => catalog.compile_implementation(&text).map(|compiled| compiled.bytes.clone()),
        };

        let bytes = compiled.unwrap_or_else(|report| panic!("{}", report.render(&definition.path, &text)));

        assert!(bytes == definition.bytes, "{} compiles to other bytes:\n{text}", definition.path);
    }
}

/// The keys that the compiler drops, removed from a source file.
fn without_dropped_keys(value: &Value, top: bool) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| key.as_str() != "annotations" && !(top && key.as_str() == "name"))
                .map(|(key, value)| (key.clone(), without_dropped_keys(value, false)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(|value| without_dropped_keys(value, false)).collect()),
        other => other.clone(),
    }
}

/// Every place where `decompiled` differs from `source`, including the order of keys.
fn differences(pointer: &str, source: &Value, decompiled: &Value) -> Vec<String> {
    match (source, decompiled) {
        (Value::Object(source), Value::Object(decompiled)) => {
            let source_keys: Vec<&String> = source.keys().collect();
            let decompiled_keys: Vec<&String> = decompiled.keys().collect();
            let order = (source_keys != decompiled_keys)
                .then(|| format!("{pointer}: keys {source_keys:?} became {decompiled_keys:?}"));

            let nested = source.iter().filter_map(|(key, value)| Some((key, value, decompiled.get(key)?)));

            order
                .into_iter()
                .chain(
                    nested.flat_map(|(key, source, decompiled)| {
                        differences(&format!("{pointer}/{key}"), source, decompiled)
                    }),
                )
                .collect()
        }
        (Value::Array(source), Value::Array(decompiled)) if source.len() == decompiled.len() => source
            .iter()
            .zip(decompiled)
            .enumerate()
            .flat_map(|(index, (source, decompiled))| differences(&format!("{pointer}/{index}"), source, decompiled))
            .collect(),
        _ if source == decompiled => Vec::new(),
        _ => vec![format!("{pointer}: {source} became {decompiled}")],
    }
}

/// The definitions write the cluster as its genesis hash, and the decompiler writes its name. One
/// account of the definitions writes `signer` before `writable`.
#[test]
fn decompiled_json_differs_from_the_source_only_in_canonical_spellings() {
    let tree = compile_tree();
    let mut found: Vec<String> = tree
        .decompiled()
        .into_iter()
        .flat_map(|Decompiled { definition, json }| {
            let source = without_dropped_keys(&serde_json::from_str(&definition.text).unwrap(), true);

            differences("", &source, &json).into_iter().map(|difference| format!("{} {difference}", definition.path))
        })
        .collect();

    found.sort();

    let clusters = tree.implementations.iter().map(|definition| {
        format!("{} /cluster: \"5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d\" became \"mainnet\"", definition.path)
    });

    let flag_order = "solana.org/implementations/hastra-prime-unstake/1.0.0.json /recipe/accounts/1: \
                      keys [\"name\", \"address\", \"signer\", \"writable\"] became [\"name\", \"address\", \"writable\", \"signer\"]";

    let mut expected: Vec<String> = clusters.chain([flag_order.to_owned()]).collect();
    expected.sort();

    assert_eq!(found, expected, "\n{}", found.join("\n"));
}

#[test]
fn an_unknown_publisher_or_another_interface_is_an_error() {
    let tree = compile_tree();
    let implementation = tree.implementations.first().unwrap();
    let interface = tree.interface_of(implementation);
    let other = tree.interfaces.iter().find(|definition| definition.bytes != interface).unwrap();

    assert!(matches!(decompile_interface(interface, &Organizations::new()), Err(DecompileError::UnknownPublisher(_))));
    assert_eq!(
        decompile_implementation(&implementation.bytes, &other.bytes, &organizations()),
        Err(DecompileError::WrongInterface)
    );
}

#[test]
fn bytes_that_do_not_parse_are_an_error() {
    let tree = compile_tree();
    let interface = &tree.interfaces.first().unwrap().bytes;
    let cut = interface.get(..interface.len().saturating_sub(1)).unwrap();

    assert_eq!(decompile_interface(cut, &organizations()), Err(DecompileError::Spec(SpecError::LengthMismatch)));
    assert_eq!(
        decompile_implementation(interface, interface, &organizations()),
        Err(DecompileError::Spec(SpecError::WrongKind))
    );
}

/// A declared account that looks like one the compiler adds stays declared, because its name comes
/// before the instruction literals in the pool.
const DECLARED_PROGRAM: &str = r#"{
  "spec": "sdp-intents@1.0", "kind": "implementation", "id": "solana.org/declared-program", "version": "1.0.0",
  "cluster": "mainnet", "implements": "solana.org/token.transfer@^1",
  "message": "transfer {inputs.amount} SOL to {inputs.to}",
  "recipe": {
    "kind": "static",
    "accounts": [
      { "name": "from", "address": "{inputs.from}", "writable": true, "signer": true },
      { "name": "systemProgram", "address": "11111111111111111111111111111111" },
      { "name": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "address": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" }
    ],
    "instructions": [
      { "program": "11111111111111111111111111111111", "accounts": ["from"], "data": [{ "value": "02000000", "encoding": "hex" }] },
      { "program": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "accounts": [], "data": [{ "value": "6869", "encoding": "hex" }] }
    ]
  }
}"#;

#[test]
fn keeps_a_declared_account_that_looks_added() {
    let mut catalog = crate::test_support::catalog();
    let interface = catalog.interfaces().next().unwrap().bytes.clone();
    let bytes = catalog.compile_implementation(DECLARED_PROGRAM).unwrap().bytes.clone();
    let organizations = Organizations::from([(crate::test_support::SOLANA_ORG, "solana.org".to_owned())]);

    let json = decompile_implementation(&bytes, &interface, &organizations).unwrap();
    let recompiled = catalog.compile_implementation(&json.to_string()).unwrap();

    assert_eq!(json.pointer("/recipe/accounts").and_then(Value::as_array).map(Vec::len), Some(3));
    assert_eq!(recompiled.bytes, bytes);
}
