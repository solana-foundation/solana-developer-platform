//! Finds where each JSON value and key starts and ends, by its JSON pointer, so that a finding can
//! show the line and the text that it is about. The scanner runs only on text that `serde_json`
//! already parsed.

use std::collections::HashMap;

const OBJECT_START: u8 = b'{';
const OBJECT_END: u8 = b'}';
const ARRAY_START: u8 = b'[';
const ARRAY_END: u8 = b']';
const QUOTE: u8 = b'"';
const COMMA: u8 = b',';
const ESCAPE: u8 = b'\\';

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

/// The span of every value, and of every object key, by JSON pointer.
#[derive(Debug, Default)]
pub struct SpanIndex {
    values: HashMap<String, Span>,
    keys: HashMap<String, Span>,
}

impl SpanIndex {
    pub fn build(text: &str) -> Self {
        let mut scanner = Scanner { bytes: text.as_bytes(), at: 0, index: Self::default() };
        scanner.value(String::new());

        scanner.index
    }

    pub fn value(&self, pointer: &str) -> Option<Span> {
        self.values.get(pointer).copied()
    }

    /// The span of the key whose value is at `pointer`.
    pub fn key(&self, pointer: &str) -> Option<Span> {
        self.keys.get(pointer).copied()
    }
}

struct Scanner<'t> {
    bytes: &'t [u8],
    at: usize,
    index: SpanIndex,
}

impl Scanner<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn bump(&mut self) {
        self.at = self.at.saturating_add(1);
    }

    fn whitespace(&mut self) {
        while self.peek().is_some_and(|byte| byte.is_ascii_whitespace()) {
            self.bump();
        }
    }

    fn value(&mut self, pointer: String) {
        self.whitespace();
        let start = self.at;

        match self.peek() {
            Some(OBJECT_START) => self.object(&pointer),
            Some(ARRAY_START) => self.array(&pointer),
            Some(QUOTE) => {
                self.string();
            }
            _ => self.scalar(),
        }

        self.index.values.insert(pointer, Span { start, end: self.at });
    }

    fn object(&mut self, pointer: &str) {
        self.bump();

        loop {
            self.whitespace();

            if self.peek() != Some(QUOTE) {
                self.bump();

                return;
            }

            let key_start = self.at;
            let key = self.string();
            let member = format!("{pointer}/{}", escape_pointer(&key));
            self.index.keys.insert(member.clone(), Span { start: key_start, end: self.at });

            self.whitespace();
            self.bump();
            self.value(member);
            self.whitespace();

            if self.peek() == Some(COMMA) {
                self.bump();
            }
        }
    }

    fn array(&mut self, pointer: &str) {
        self.bump();

        for index in 0usize.. {
            self.whitespace();

            if self.peek() == Some(ARRAY_END) || self.peek().is_none() {
                self.bump();

                return;
            }

            self.value(format!("{pointer}/{index}"));
            self.whitespace();

            if self.peek() == Some(COMMA) {
                self.bump();
            }
        }
    }

    /// Returns the raw text between the quotes. Keys with escapes are rare, and a raw key still
    /// finds the right span when it has none.
    fn string(&mut self) -> String {
        self.bump();
        let start = self.at;

        while let Some(byte) = self.peek() {
            match byte {
                ESCAPE => {
                    self.bump();
                    self.bump();
                }
                QUOTE => break,
                _ => self.bump(),
            }
        }

        let text = String::from_utf8_lossy(self.bytes.get(start..self.at).unwrap_or_default()).into_owned();
        self.bump();

        text
    }

    fn scalar(&mut self) {
        while self
            .peek()
            .is_some_and(|byte| !matches!(byte, COMMA | OBJECT_END | ARRAY_END) && !byte.is_ascii_whitespace())
        {
            self.bump();
        }
    }
}

/// RFC 6901: `~` becomes `~0`, and `/` becomes `~1`.
pub fn escape_pointer(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT: &str = r#"{
  "id": "solana.org/token.transfer",
  "inputs": [
    { "name": "from", "type": "address" }
  ]
}"#;

    fn text(span: Span) -> &'static str {
        TEXT.get(span.start..span.end).unwrap()
    }

    #[test]
    fn finds_values_and_keys_by_pointer() {
        let index = SpanIndex::build(TEXT);

        assert_eq!(text(index.value("/id").unwrap()), "\"solana.org/token.transfer\"");
        assert_eq!(text(index.value("/inputs/0/type").unwrap()), "\"address\"");
        assert_eq!(text(index.key("/inputs/0/name").unwrap()), "\"name\"");
        assert!(text(index.value("/inputs/0").unwrap()).starts_with("{ \"name\""));
    }

    #[test]
    fn escapes_slashes_in_keys() {
        let index = SpanIndex::build(r#"{ "approvals": { "solana.org/spl-token-transfer": ["1.0.0"] } }"#);

        assert!(index.value("/approvals/solana.org~1spl-token-transfer/0").is_some());
    }
}
