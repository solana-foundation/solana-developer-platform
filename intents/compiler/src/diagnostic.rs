//! Findings, and the text that shows them. A finding names the JSON pointer of the value that it is
//! about. `Report::render` turns the pointer into a file, a line, a column, and a caret under the
//! value, in the style of `rustc`.

use std::fmt::Write as _;

use crate::spans::{Span, SpanIndex};

/// A stable name for each kind of finding. Tools and tests match on the name, not on the message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    InvalidJson,
    UnknownKey,
    MissingKey,
    WrongType,
    InvalidValue,
    UnknownReference,
    ReferenceNotAllowed,
    BadTemplate,
    UnknownEncoding,
    EncodingMismatch,
    UnknownPublisher,
    UnknownInterface,
    InterfaceFailed,
    VersionMismatch,
    DuplicateName,
    LaterAccount,
    BuilderAccountWritable,
    BuilderAccountSigner,
    BuilderAccountPayer,
    LimitExceeded,
    PathMismatch,
    Internal,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidJson => "invalidJson",
            Self::UnknownKey => "unknownKey",
            Self::MissingKey => "missingKey",
            Self::WrongType => "wrongType",
            Self::InvalidValue => "invalidValue",
            Self::UnknownReference => "unknownReference",
            Self::ReferenceNotAllowed => "referenceNotAllowed",
            Self::BadTemplate => "badTemplate",
            Self::UnknownEncoding => "unknownEncoding",
            Self::EncodingMismatch => "encodingMismatch",
            Self::UnknownPublisher => "unknownPublisher",
            Self::UnknownInterface => "unknownInterface",
            Self::InterfaceFailed => "interfaceFailed",
            Self::VersionMismatch => "versionMismatch",
            Self::DuplicateName => "duplicateName",
            Self::LaterAccount => "laterAccount",
            Self::BuilderAccountWritable => "builderAccountWritable",
            Self::BuilderAccountSigner => "builderAccountSigner",
            Self::BuilderAccountPayer => "builderAccountPayer",
            Self::LimitExceeded => "limitExceeded",
            Self::PathMismatch => "pathMismatch",
            Self::Internal => "internal",
        }
    }
}

/// Whether a finding is about a value or about the key that holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Value,
    Key,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: Code,
    pub pointer: String,
    pub part: Part,
    pub message: String,
    pub help: Option<String>,
}

impl Diagnostic {
    pub fn new(code: Code, pointer: &str, message: impl Into<String>) -> Self {
        Self { code, pointer: pointer.to_owned(), part: Part::Value, message: message.into(), help: None }
    }

    pub fn at_key(mut self) -> Self {
        self.part = Part::Key;
        self
    }

    pub fn help(mut self, help: impl Into<String>) -> Self {
        self.help = Some(help.into());
        self
    }
}

/// The findings for one file. A `serde_json` syntax error has no pointer, so it keeps its own line
/// and column.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub diagnostics: Vec<Diagnostic>,
    pub syntax: Option<SyntaxError>,
}

/// A line and a column, both from 1. The column counts characters, not bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Location {
    pub line: usize,
    pub column: usize,
}

/// A finding, and where its value starts. A pointer that names nothing in the file has no location.
#[derive(Clone, Copy, Debug)]
pub struct Located<'r> {
    pub diagnostic: &'r Diagnostic,
    pub location: Option<Location>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntaxError {
    pub line: usize,
    pub column: usize,
    pub message: String,
}

impl Report {
    pub fn is_empty(&self) -> bool {
        self.diagnostics.is_empty() && self.syntax.is_none()
    }

    pub fn codes(&self) -> Vec<Code> {
        self.diagnostics.iter().map(|diagnostic| diagnostic.code).collect()
    }

    pub fn render(&self, path: &str, text: &str) -> String {
        let index = SpanIndex::build(text);
        let mut out = String::new();

        if let Some(syntax) = &self.syntax {
            let _ = writeln!(out, "error[{}]: {}", Code::InvalidJson.as_str(), syntax.message);
            let _ = writeln!(out, "  --> {path}:{}:{}", syntax.line, syntax.column);
        }

        self.diagnostics.iter().for_each(|diagnostic| render_one(&mut out, diagnostic, path, text, &index));
        out
    }

    pub fn located(&self, text: &str) -> Vec<Located<'_>> {
        let index = SpanIndex::build(text);

        self.diagnostics
            .iter()
            .map(|diagnostic| Located {
                diagnostic,
                location: span_of(diagnostic, &index).map(|span| location(text, span.start)),
            })
            .collect()
    }
}

fn span_of(diagnostic: &Diagnostic, index: &SpanIndex) -> Option<Span> {
    match diagnostic.part {
        Part::Value => index.value(&diagnostic.pointer),
        Part::Key => index.key(&diagnostic.pointer).or_else(|| index.value(&diagnostic.pointer)),
    }
}

fn location(text: &str, offset: usize) -> Location {
    let before = text.get(..offset).unwrap_or_default();
    let line_start = before.rfind('\n').map_or(0, |at| at.saturating_add(1));

    Location {
        line: before.matches('\n').count().saturating_add(1),
        column: before.get(line_start..).unwrap_or_default().chars().count().saturating_add(1),
    }
}

fn render_one(out: &mut String, diagnostic: &Diagnostic, path: &str, text: &str, index: &SpanIndex) {
    let span = span_of(diagnostic, index);

    let _ = writeln!(out, "error[{}]: {}", diagnostic.code.as_str(), diagnostic.message);

    match span {
        Some(span) => render_snippet(out, path, text, span),
        None => {
            let _ = writeln!(out, "  --> {path}");
        }
    }

    let pointer = if diagnostic.pointer.is_empty() { "/" } else { diagnostic.pointer.as_str() };
    let _ = writeln!(out, "   = at {pointer}");

    if let Some(help) = &diagnostic.help {
        let _ = writeln!(out, "   = help: {help}");
    }

    out.push('\n');
}

/// Shows the first line of the span, with carets under the part of it on that line.
fn render_snippet(out: &mut String, path: &str, text: &str, span: Span) {
    let Location { line: line_number, column } = location(text, span.start);
    let line_start = text.get(..span.start).unwrap_or_default().rfind('\n').map_or(0, |at| at.saturating_add(1));

    let line = text.get(line_start..).unwrap_or_default().lines().next().unwrap_or_default();
    let on_line = text.get(span.start..span.end).unwrap_or_default().lines().next().unwrap_or_default();
    let gutter = " ".repeat(line_number.to_string().len());

    let _ = writeln!(out, "  --> {path}:{line_number}:{column}");
    let _ = writeln!(out, "{gutter} |");
    let _ = writeln!(out, "{line_number} | {line}");
    let _ = writeln!(
        out,
        "{gutter} | {}{}",
        " ".repeat(column.saturating_sub(1)),
        "^".repeat(on_line.chars().count().max(1))
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_line_and_a_caret_under_the_value() {
        let text = "{\n  \"inputs\": [\n    { \"name\": \"from\", \"type\": \"adress\" }\n  ]\n}";
        let report = Report {
            diagnostics: vec![Diagnostic::new(Code::InvalidValue, "/inputs/0/type", "`adress` is not a value type")
                .help("did you mean `address`?")],
            syntax: None,
        };

        let rendered = report.render("token.transfer/1.0.0.json", text);

        assert_eq!(
            rendered,
            "error[invalidValue]: `adress` is not a value type\n  --> token.transfer/1.0.0.json:3:31\n  |\n3 |     { \"name\": \"from\", \"type\": \"adress\" }\n  |                               ^^^^^^^^\n   = at /inputs/0/type\n   = help: did you mean `address`?\n\n"
        );
    }
}
