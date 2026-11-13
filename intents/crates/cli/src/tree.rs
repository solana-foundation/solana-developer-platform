//! The definitions tree: `<organization>/<kind>/<name>/<version>.json` under one root.

use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Interface,
    Implementation,
}

impl Kind {
    fn from_folder(folder: &str) -> Option<Self> {
        match folder {
            "interfaces" => Some(Self::Interface),
            "implementations" => Some(Self::Implementation),
            _ => None,
        }
    }

    pub fn folder(self) -> &'static str {
        match self {
            Self::Interface => "interfaces",
            Self::Implementation => "implementations",
        }
    }
}

/// Where a file sits in the tree. The registry names a document by these parts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Position {
    pub organization: String,
    pub kind: Kind,
    pub name: String,
    pub version: String,
}

impl Position {
    /// Reads a path relative to the root. A file at any other place is `None`.
    pub fn parse(relative: &Path) -> Option<Self> {
        let parts: Vec<&str> =
            relative.components().map(|component| component.as_os_str().to_str()).collect::<Option<_>>()?;
        let [organization, kind, name, file] = parts.as_slice() else {
            return None;
        };

        Some(Self {
            organization: (*organization).to_owned(),
            kind: Kind::from_folder(kind)?,
            name: (*name).to_owned(),
            version: file.strip_suffix(".json")?.to_owned(),
        })
    }

    pub fn id(&self) -> String {
        format!("{}/{}", self.organization, self.name)
    }

    pub fn folder(&self) -> String {
        format!("{}/{}/{}/", self.organization, self.kind.folder(), self.name)
    }
}

pub struct Definition {
    pub path: PathBuf,
    pub position: Position,
    pub text: String,
}

/// The `index.json` of an interface or an implementation, which states what its registry index
/// must hold.
pub struct IndexFile {
    pub path: PathBuf,
    pub organization: String,
    pub kind: Kind,
    pub name: String,
    pub text: String,
}

/// The `organization.json` of an organization, which states its authority.
pub struct OrganizationFile {
    pub path: PathBuf,
    pub organization: String,
    pub text: String,
}

/// Every JSON file under the root. A stray is a JSON file at no definition's place, which lint
/// reports so that a misplaced file never goes unchecked.
pub struct Tree {
    pub definitions: Vec<Definition>,
    pub indexes: Vec<IndexFile>,
    pub organizations: Vec<OrganizationFile>,
    pub strays: Vec<PathBuf>,
}

impl Tree {
    pub fn read(root: &Path) -> Result<Self, String> {
        let mut tree =
            Self { definitions: Vec::new(), indexes: Vec::new(), organizations: Vec::new(), strays: Vec::new() };

        for path in json_files(root)? {
            let place = path.strip_prefix(root).ok().map(Place::parse).unwrap_or(Place::Stray);

            match place {
                Place::Index { organization, kind, name } => {
                    tree.indexes.push(IndexFile { text: read(&path)?, path, organization, kind, name });
                }
                Place::Organization { organization } => {
                    tree.organizations.push(OrganizationFile { text: read(&path)?, path, organization });
                }
                Place::Definition(position) => tree.definitions.push(Definition { text: read(&path)?, path, position }),
                Place::Stray => tree.strays.push(path),
            }
        }

        Ok(tree)
    }

    pub fn of_kind(&self, kind: Kind) -> impl Iterator<Item = &Definition> {
        self.definitions.iter().filter(move |definition| definition.position.kind == kind)
    }

    pub fn organizations(&self) -> Vec<&str> {
        let mut organizations: Vec<&str> =
            self.definitions.iter().map(|definition| definition.position.organization.as_str()).collect();
        organizations.dedup();

        organizations
    }
}

/// What a file is, from where it sits: `<organization>/organization.json`,
/// `<organization>/<kind>/<name>/index.json`, or a definition.
enum Place {
    Organization { organization: String },
    Index { organization: String, kind: Kind, name: String },
    Definition(Position),
    Stray,
}

impl Place {
    fn parse(relative: &Path) -> Self {
        let parts: Option<Vec<&str>> = relative.components().map(|component| component.as_os_str().to_str()).collect();

        match parts.as_deref() {
            Some([organization, "organization.json"]) => {
                Self::Organization { organization: (*organization).to_owned() }
            }
            Some([organization, kind, name, "index.json"]) => match Kind::from_folder(kind) {
                Some(kind) => Self::Index { organization: (*organization).to_owned(), kind, name: (*name).to_owned() },
                None => Self::Stray,
            },
            _ => Position::parse(relative).map_or(Self::Stray, Self::Definition),
        }
    }
}

/// The JSON files under `root`, in path order. Hidden entries, such as `.git`, are skipped.
fn json_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut folders = vec![root.to_path_buf()];
    let mut files = Vec::new();

    while let Some(folder) = folders.pop() {
        for path in entries(&folder)? {
            if path.is_dir() {
                folders.push(path);
            } else if path.extension().is_some_and(|extension| extension == "json") {
                files.push(path);
            }
        }
    }

    files.sort();

    Ok(files)
}

fn entries(folder: &Path) -> Result<Vec<PathBuf>, String> {
    let unreadable = |error: std::io::Error| format!("cannot read `{}`: {error}", folder.display());
    let paths = std::fs::read_dir(folder)
        .map_err(unreadable)?
        .map(|entry| entry.map(|entry| entry.path()).map_err(unreadable))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(paths.into_iter().filter(|path| !is_hidden(path)).collect())
}

fn is_hidden(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name.to_string_lossy().starts_with('.'))
}

fn read(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|error| format!("cannot read `{}`: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_position_from_the_path() {
        let position = Position::parse(Path::new("solana.org/implementations/system-transfer/1.0.0.json")).unwrap();

        assert_eq!(position.id(), "solana.org/system-transfer");
        assert_eq!(position.kind, Kind::Implementation);
        assert_eq!(position.version, "1.0.0");
    }

    #[test]
    fn a_file_at_another_place_has_no_position() {
        [
            "solana.org/token.transfer/1.0.0.json",
            "solana.org/intents/token.transfer/1.0.0.json",
            "solana.org/organization.json",
        ]
        .iter()
        .for_each(|path| assert_eq!(Position::parse(Path::new(path)), None, "{path}"));
    }

    #[test]
    fn reads_the_definitions_in_this_repository() {
        let tree = Tree::read(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../definitions")).unwrap();

        assert_eq!(tree.definitions.len(), 12);
        assert_eq!(tree.of_kind(Kind::Interface).count(), 3);
        assert_eq!(tree.organizations(), ["solana.org"]);
        assert!(tree.strays.is_empty());
    }
}
