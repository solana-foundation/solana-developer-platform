//! `sdp-intents lint`: compiles every definition under the root, and reports the findings.
//!
//! Interfaces compile first, so that implementations can name them. Until the registry exists,
//! every organization gets a placeholder address, which changes no finding.

use std::path::{Path, PathBuf};

use serde_json::Value;

use sdp_intents_compiler::diagnostic::{Code, Diagnostic, Report};
use sdp_intents_compiler::Catalog;
use sdp_intents_spec::Address;

use crate::output::{self, Format};
use crate::tree::{Definition, Kind, Tree};

#[derive(clap::Args)]
pub struct LintArgs {
    /// Files or folders to report on. Every definition under the root still compiles, so that an
    /// implementation can name an interface outside these paths.
    paths: Vec<PathBuf>,

    /// The folder that holds `<organization>/<kind>/<name>/<version>.json`.
    #[arg(long, default_value = "definitions")]
    root: PathBuf,

    #[arg(long, value_enum, default_value_t = Format::Human)]
    format: Format,
}

pub enum Outcome {
    Clean,
    Findings,
}

/// The findings for one definition. A definition with no findings has no `FileReport`.
pub struct FileReport<'t> {
    pub definition: &'t Definition,
    pub report: Report,
}

pub fn run(args: &LintArgs) -> Result<Outcome, String> {
    let tree = Tree::read(&args.root)?;
    let scope = Scope::new(&args.root, &args.paths)?;

    let reports: Vec<FileReport<'_>> =
        lint(&tree).into_iter().filter(|report| scope.contains(&report.definition.path)).collect();
    let strays: Vec<&Path> = tree.strays.iter().map(PathBuf::as_path).filter(|path| scope.contains(path)).collect();
    let checked = tree.definitions.iter().filter(|definition| scope.contains(&definition.path)).count();

    print!("{}", output::render(args.format, &reports, &strays));
    eprintln!("{} of {checked} definitions compiled", checked.saturating_sub(reports.len()));

    Ok(if reports.is_empty() && strays.is_empty() { Outcome::Clean } else { Outcome::Findings })
}

pub fn lint(tree: &Tree) -> Vec<FileReport<'_>> {
    compile_tree(tree).reports
}

/// Every definition of a tree, compiled into one catalog, with the findings of the files that did
/// not compile.
pub struct CompiledTree<'t> {
    pub catalog: Catalog,
    pub reports: Vec<FileReport<'t>>,
}

pub fn compile_tree(tree: &Tree) -> CompiledTree<'_> {
    let mut catalog = tree
        .organizations()
        .into_iter()
        .fold(Catalog::default(), |catalog, organization| catalog.with_publisher(organization, Address::default()));

    let mut reports = Vec::new();

    for definition in tree.of_kind(Kind::Interface) {
        let report = catalog.compile_interface(&definition.text).err().unwrap_or_default();
        reports.push(with_position_findings(definition, report));
    }

    for definition in tree.of_kind(Kind::Implementation) {
        let report = catalog.compile_implementation(&definition.text).err().unwrap_or_default();
        reports.push(with_position_findings(definition, report));
    }

    CompiledTree { catalog, reports: reports.into_iter().filter(|report| !report.report.is_empty()).collect() }
}

fn with_position_findings(definition: &Definition, mut report: Report) -> FileReport<'_> {
    report.diagnostics.extend(position_findings(definition));

    FileReport { definition, report }
}

/// The registry names a document by its place in the tree, so the `id` and `version` in the file
/// must match the place. A file that is not JSON has no finding here, because the compile reports it.
fn position_findings(definition: &Definition) -> Vec<Diagnostic> {
    let Ok(value) = serde_json::from_str::<Value>(&definition.text) else {
        return Vec::new();
    };

    let position = &definition.position;
    let id = position.id();
    let stated = |key: &str| value.get(key).and_then(Value::as_str);

    let id_finding = stated("id").filter(|stated| *stated != id).map(|stated| {
        Diagnostic::new(
            Code::PathMismatch,
            "/id",
            format!("the id is `{stated}`, but the file is in `{}`", position.folder()),
        )
        .help(format!("change the id to `{id}`, or move the file to the folder of `{stated}`"))
    });

    let version_finding = stated("version").filter(|stated| *stated != position.version).map(|stated| {
        Diagnostic::new(
            Code::PathMismatch,
            "/version",
            format!("the version is `{stated}`, but the file is `{}.json`", position.version),
        )
        .help(format!("rename the file to `{stated}.json`, or change the version to `{}`", position.version))
    });

    id_finding.into_iter().chain(version_finding).collect()
}

/// The paths to report on. No paths means the whole root.
struct Scope {
    paths: Vec<PathBuf>,
}

impl Scope {
    fn new(root: &Path, paths: &[PathBuf]) -> Result<Self, String> {
        let root = canonical(root)?;
        let paths = paths.iter().map(|path| canonical(path)).collect::<Result<Vec<_>, _>>()?;

        if let Some(outside) = paths.iter().find(|path| !path.starts_with(&root)) {
            return Err(format!("`{}` is not under the root `{}`", outside.display(), root.display()));
        }

        Ok(Self { paths })
    }

    fn contains(&self, path: &Path) -> bool {
        self.paths.is_empty()
            || canonical(path).is_ok_and(|path| self.paths.iter().any(|scope| path.starts_with(scope)))
    }
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize().map_err(|error| format!("cannot find `{}`: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::Position;

    const TOKEN_TRANSFER: &str = include_str!("../../definitions/solana.org/interfaces/token.transfer/1.0.0.json");
    const SYSTEM_TRANSFER: &str =
        include_str!("../../definitions/solana.org/implementations/system-transfer/1.0.0.json");

    fn definition(path: &str, text: &str) -> Definition {
        Definition {
            path: PathBuf::from(path),
            position: Position::parse(Path::new(path)).unwrap(),
            text: text.to_owned(),
        }
    }

    fn tree(definitions: Vec<Definition>) -> Tree {
        Tree { definitions, strays: Vec::new() }
    }

    #[test]
    fn the_definitions_in_this_repository_have_no_findings() {
        let tree = Tree::read(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../definitions")).unwrap();

        assert!(lint(&tree).is_empty());
    }

    #[test]
    fn the_id_and_version_match_the_place_of_the_file() {
        let tree = tree(vec![
            definition("solana.org/interfaces/token.transfer/1.0.0.json", TOKEN_TRANSFER),
            definition("solana.org/implementations/sol-transfer/1.0.1.json", SYSTEM_TRANSFER),
        ]);

        let reports = lint(&tree);
        let report = &reports.first().unwrap().report;

        assert_eq!(reports.len(), 1);
        assert_eq!(report.codes(), [Code::PathMismatch, Code::PathMismatch]);
        assert_eq!(
            report.diagnostics.first().unwrap().message,
            "the id is `solana.org/system-transfer`, but the file is in `solana.org/implementations/sol-transfer/`"
        );
    }

    #[test]
    fn an_implementation_of_a_failed_interface_says_so() {
        let broken = TOKEN_TRANSFER.replacen("\"type\": \"address\"", "\"type\": \"adress\"", 1);
        let tree = tree(vec![
            definition("solana.org/interfaces/token.transfer/1.0.0.json", &broken),
            definition("solana.org/implementations/system-transfer/1.0.0.json", SYSTEM_TRANSFER),
        ]);

        let codes: Vec<Vec<Code>> = lint(&tree).iter().map(|report| report.report.codes()).collect();

        assert_eq!(codes, [vec![Code::InvalidValue], vec![Code::InterfaceFailed]]);
    }
}
