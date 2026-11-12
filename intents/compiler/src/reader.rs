//! Reads JSON with a pointer on every node. A wrong type or an unknown key adds a finding to the
//! `Sink` and returns `None`, so that one pass reports every finding in a file.

use serde_json::{Map, Value};

use crate::diagnostic::{Code, Diagnostic};
use crate::spans::escape_pointer;
use crate::suggest::closest;

/// Keys that any object may hold. Readers ignore them.
const IGNORED_KEYS: [&str; 1] = ["annotations"];

#[derive(Debug, Default)]
pub struct Sink {
    diagnostics: Vec<Diagnostic>,
}

impl Sink {
    pub fn push(&mut self, diagnostic: Diagnostic) {
        self.diagnostics.push(diagnostic);
    }

    pub fn is_empty(&self) -> bool {
        self.diagnostics.is_empty()
    }

    pub fn into_diagnostics(self) -> Vec<Diagnostic> {
        self.diagnostics
    }
}

#[derive(Clone, Debug)]
pub struct Node<'v> {
    pub value: &'v Value,
    pub pointer: String,
}

impl<'v> Node<'v> {
    pub fn root(value: &'v Value) -> Self {
        Self { value, pointer: String::new() }
    }

    pub fn str(&self, sink: &mut Sink) -> Option<&'v str> {
        self.value.as_str().or_else(|| self.wrong_type(sink, "a string"))
    }

    pub fn bool(&self, sink: &mut Sink) -> Option<bool> {
        self.value.as_bool().or_else(|| self.wrong_type(sink, "true or false"))
    }

    pub fn array(&self, sink: &mut Sink) -> Option<Vec<Node<'v>>> {
        let Some(items) = self.value.as_array() else {
            return self.wrong_type(sink, "an array");
        };

        Some(
            items
                .iter()
                .enumerate()
                .map(|(index, value)| Node { value, pointer: format!("{}/{index}", self.pointer) })
                .collect(),
        )
    }

    pub fn object(&self, sink: &mut Sink) -> Option<Object<'v>> {
        let Some(map) = self.value.as_object() else {
            return self.wrong_type(sink, "an object");
        };

        Some(Object { map, pointer: self.pointer.clone(), asked: Vec::new() })
    }

    pub fn is_object(&self) -> bool {
        self.value.is_object()
    }

    fn wrong_type<T>(&self, sink: &mut Sink, expected: &str) -> Option<T> {
        sink.push(Diagnostic::new(
            Code::WrongType,
            &self.pointer,
            format!("expected {expected}, found {}", describe(self.value)),
        ));

        None
    }
}

/// An object whose keys the reader asks for one at a time. `finish` reports every key that no
/// reader asked for.
pub struct Object<'v> {
    map: &'v Map<String, Value>,
    pointer: String,
    asked: Vec<String>,
}

impl<'v> Object<'v> {
    pub fn pointer(&self) -> &str {
        &self.pointer
    }

    pub fn field(&mut self, key: &str) -> Option<Node<'v>> {
        self.asked.push(key.to_owned());

        self.map.get(key).map(|value| Node { value, pointer: format!("{}/{}", self.pointer, escape_pointer(key)) })
    }

    pub fn required(&mut self, key: &str, sink: &mut Sink) -> Option<Node<'v>> {
        let node = self.field(key);

        if node.is_none() {
            sink.push(Diagnostic::new(Code::MissingKey, &self.pointer, format!("missing the key `{key}`")));
        }

        node
    }

    /// The first key other than `except`, for objects that name their kind by a key, such as
    /// `{ "pda": … }` or `{ "outflow": …, "message": … }`.
    pub fn only_key_except(&self, except: &str) -> Option<&'v str> {
        self.map.keys().map(String::as_str).find(|key| !IGNORED_KEYS.contains(key) && *key != except)
    }

    pub fn finish(self, sink: &mut Sink) {
        self.map.keys().filter(|key| !self.asked.contains(key) && !IGNORED_KEYS.contains(&key.as_str())).for_each(
            |key| {
                let pointer = format!("{}/{}", self.pointer, escape_pointer(key));
                let diagnostic = Diagnostic::new(Code::UnknownKey, &pointer, format!("unknown key `{key}`")).at_key();

                sink.push(match closest(key, self.asked.iter().map(String::as_str)) {
                    Some(known) => diagnostic.help(format!("did you mean `{known}`?")),
                    None => diagnostic.help(format!("expected one of {}", list(&self.asked))),
                });
            },
        );
    }
}

/// Lists names as `` `a`, `b`, `c` ``.
pub fn list<S: AsRef<str>>(names: &[S]) -> String {
    names.iter().map(|name| format!("`{}`", name.as_ref())).collect::<Vec<_>>().join(", ")
}

fn describe(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(_) => "a boolean".to_owned(),
        Value::Number(number) => format!("the number {number}"),
        Value::String(text) => format!("the string \"{text}\""),
        Value::Array(_) => "an array".to_owned(),
        Value::Object(_) => "an object".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reports_unknown_keys_with_a_suggestion() {
        let value = json!({ "name": "from", "typ": "address" });
        let mut sink = Sink::default();

        let mut object = Node::root(&value).object(&mut sink).unwrap();
        object.required("name", &mut sink);
        object.field("type");
        object.finish(&mut sink);

        let diagnostics = sink.into_diagnostics();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics.first().unwrap().pointer, "/typ");
        assert_eq!(diagnostics.first().unwrap().help.as_deref(), Some("did you mean `type`?"));
    }

    #[test]
    fn names_the_type_that_it_found() {
        let value = json!({ "inputs": 4 });
        let mut sink = Sink::default();

        let mut object = Node::root(&value).object(&mut sink).unwrap();
        assert!(object.required("inputs", &mut sink).unwrap().array(&mut sink).is_none());

        assert_eq!(sink.into_diagnostics().first().unwrap().message, "expected an array, found the number 4");
    }
}
