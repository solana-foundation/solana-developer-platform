//! The text that `lint` prints: the `rustc` style for a person, or GitHub workflow commands, which
//! show each finding as an annotation on the line of the pull request.

use std::fmt::Write as _;
use std::path::Path;

use sdp_intents_compiler::diagnostic::{Diagnostic, Location};

use crate::lint::FileReport;

const STRAY: &str = "strayFile";
const STRAY_HELP: &str = "a definition is at `<organization>/<interfaces|implementations>/<name>/<version>.json`";

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub enum Format {
    Human,
    Github,
}

pub fn render(format: Format, reports: &[FileReport<'_>], strays: &[&Path]) -> String {
    match format {
        Format::Human => human(reports, strays),
        Format::Github => github(reports, strays),
    }
}

fn human(reports: &[FileReport<'_>], strays: &[&Path]) -> String {
    let findings = reports.iter().map(|file| file.report.render(&file.path.display().to_string(), file.text));
    let strays = strays.iter().map(|path| {
        format!(
            "error[{STRAY}]: `{}` is not at the place of a definition, so lint cannot check it\n   = help: {STRAY_HELP}\n\n",
            path.display()
        )
    });

    findings.chain(strays).collect()
}

fn github(reports: &[FileReport<'_>], strays: &[&Path]) -> String {
    let mut out = String::new();

    for file in reports {
        let path = file.path.display().to_string();

        if let Some(syntax) = &file.report.syntax {
            let location = Location { line: syntax.line, column: syntax.column };
            annotate(&mut out, &path, Some(location), "invalidJson", &syntax.message);
        }

        for located in file.report.located(file.text) {
            annotate(&mut out, &path, located.location, located.diagnostic.code.as_str(), &message(located.diagnostic));
        }
    }

    for path in strays {
        let message = format!("this file is not at the place of a definition, so lint cannot check it\n{STRAY_HELP}");
        annotate(&mut out, &path.display().to_string(), None, STRAY, &message);
    }

    out
}

/// The help goes on its own line, and the pointer on the last, as `Report::render` shows them.
fn message(diagnostic: &Diagnostic) -> String {
    let help = diagnostic.help.as_ref().map(|help| format!("\nhelp: {help}")).unwrap_or_default();
    let pointer = if diagnostic.pointer.is_empty() { "/" } else { diagnostic.pointer.as_str() };

    format!("{}{help}\nat {pointer}", diagnostic.message)
}

fn annotate(out: &mut String, path: &str, location: Option<Location>, code: &str, message: &str) {
    let place = location.map(|Location { line, column }| format!(",line={line},col={column}")).unwrap_or_default();
    let _ = writeln!(out, "::error file={}{place},title={code}::{}", escape_property(path), escape_data(message));
}

/// GitHub reads `%`, a carriage return, and a line feed as the end of a workflow command.
fn escape_data(text: &str) -> String {
    text.replace('%', "%25").replace('\r', "%0D").replace('\n', "%0A")
}

/// A property also ends at `:` and `,`.
fn escape_property(text: &str) -> String {
    escape_data(text).replace(':', "%3A").replace(',', "%2C")
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use sdp_intents_compiler::diagnostic::{Code, Report};

    use super::*;
    use crate::tree::{Definition, Position};

    #[test]
    fn a_finding_is_an_annotation_on_its_line() {
        let path = "solana.org/interfaces/token.transfer/1.0.0.json";
        let definition = Definition {
            path: PathBuf::from(path),
            position: Position::parse(Path::new(path)).unwrap(),
            text: "{\n  \"version\": \"1.0\"\n}".to_owned(),
        };
        let report = Report {
            diagnostics: vec![
                Diagnostic::new(Code::InvalidValue, "/version", "`1.0` is not a version: use 100%").help("use `1.0.0`")
            ],
            syntax: None,
        };

        let out = render(
            Format::Github,
            &[FileReport { path: &definition.path, text: &definition.text, report }],
            &[Path::new("a,b.json")],
        );

        assert_eq!(
            out,
            "::error file=solana.org/interfaces/token.transfer/1.0.0.json,line=2,col=14,title=invalidValue::`1.0` is not a version: use 100%25%0Ahelp: use `1.0.0`%0Aat /version\n\
             ::error file=a%2Cb.json,title=strayFile::this file is not at the place of a definition, so lint cannot check it%0Aa definition is at `<organization>/<interfaces|implementations>/<name>/<version>.json`\n"
        );
    }
}
