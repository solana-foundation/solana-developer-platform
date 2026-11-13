//! The organization and index files of the tree, read into what each states the registry must hold.
//! A file with a finding gives a report, which lint prints with the findings of the definitions.
//!
//! An authority that a file leaves out is `Address::default()` in an index, which follows the
//! organization authority, and the signer of `apply` for an organization.

use serde_json::{Map, Value};

use sdp_intents_compiler::diagnostic::{Code, Diagnostic, Report};
use sdp_intents_compiler::{parse_version, Catalog, Id};
use sdp_intents_spec::wire::SemverV1;
use sdp_intents_spec::Address;

use crate::tree::{IndexFile, Kind, OrganizationFile, Tree};

pub struct OrganizationSettings {
    pub organization: String,
    pub authority: Option<Address>,
}

/// What an index must hold. The approve authority, the approval policy, and the approvals are an
/// interface's only.
pub struct IndexSettings {
    pub id: Id,
    pub kind: Kind,
    pub update_authority: Address,
    pub approve_authority: Address,
    pub head: Option<SemverV1>,
    pub approve_new_versions: bool,
    pub approvals: Vec<ApprovedImplementation>,
}

pub struct ApprovedImplementation {
    pub id: Id,
    pub versions: Vec<SemverV1>,
}

/// Every organization and index file of the tree.
pub struct TreeSettings {
    pub organizations: Vec<OrganizationSettings>,
    pub indexes: Vec<IndexSettings>,
}

/// The settings of the tree, or the first file with a finding. `lint` reports every finding.
pub fn read_settings(tree: &Tree) -> Result<TreeSettings, String> {
    let failed = |path: &std::path::Path| format!("`{}` has findings. Run `sdp-intents lint`.", path.display());
    let organizations = tree
        .organizations
        .iter()
        .map(|file| read_organization(file).map_err(|_| failed(&file.path)))
        .collect::<Result<Vec<_>, _>>()?;
    let indexes = tree
        .indexes
        .iter()
        .map(|file| read_index(file).map_err(|_| failed(&file.path)))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(TreeSettings { organizations, indexes })
}

pub fn read_organization(file: &OrganizationFile) -> Result<OrganizationSettings, Report> {
    let object = object(&file.text)?;
    let mut findings = unknown_keys(&object, &["authority"]);
    let authority = optional_address(&object, "authority", &mut findings);

    finish(findings, OrganizationSettings { organization: file.organization.clone(), authority })
}

pub fn read_index(file: &IndexFile) -> Result<IndexSettings, Report> {
    let object = object(&file.text)?;
    let allowed: &[&str] = match file.kind {
        Kind::Interface => &["updateAuthority", "approveAuthority", "head", "approveNewVersions", "approvals"],
        Kind::Implementation => &["updateAuthority", "head"],
    };
    let mut findings = unknown_keys(&object, allowed);

    let update_authority = optional_address(&object, "updateAuthority", &mut findings).unwrap_or_default();
    let approve_authority = optional_address(&object, "approveAuthority", &mut findings).unwrap_or_default();
    let head = object.get("head").and_then(|value| version(value, "/head", &mut findings));
    let approve_new_versions = match object.get("approveNewVersions") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => {
            findings.push(Diagnostic::new(Code::WrongType, "/approveNewVersions", "`approveNewVersions` is a boolean"));
            false
        }
    };
    let approvals = object.get("approvals").map(|value| approvals(value, &mut findings)).unwrap_or_default();

    let settings = IndexSettings {
        id: Id { organization: file.organization.clone(), name: file.name.clone() },
        kind: file.kind,
        update_authority,
        approve_authority,
        head,
        approve_new_versions,
        approvals,
    };

    finish(findings, settings)
}

/// The findings that need the definitions: a head and each approved version must be in the tree,
/// and each approved implementation must implement the interface.
pub fn check_references(settings: &IndexSettings, catalog: &Catalog) -> Vec<Diagnostic> {
    let in_tree = |kind: Kind, id: &Id, version: &SemverV1| match kind {
        Kind::Interface => catalog.interfaces().any(|interface| interface.id == *id && interface.version == *version),
        Kind::Implementation => catalog
            .implementations()
            .any(|implementation| implementation.id == *id && implementation.version == *version),
    };

    let head = settings.head.filter(|head| !in_tree(settings.kind, &settings.id, head)).map(|head| {
        Diagnostic::new(Code::InvalidValue, "/head", format!("{} has no version {}", settings.id, version_text(&head)))
    });

    let approvals = settings.approvals.iter().flat_map(|approved| {
        let pointer = format!("/approvals/{}", approved.id);
        let implements = catalog.implementations().any(|implementation| {
            implementation.id == approved.id
                && implementation.implements.name_hash == settings.id.name_hash()
                && implementation.implements.publisher == crate::lint::publisher(&settings.id.organization)
        });
        let other_interface = (!implements).then(|| {
            Diagnostic::new(
                Code::UnknownImplementation,
                &pointer,
                format!("{} is no implementation of {}", approved.id, settings.id),
            )
        });
        let missing = approved
            .versions
            .iter()
            .filter(|version| implements && !in_tree(Kind::Implementation, &approved.id, version))
            .map(|version| {
                Diagnostic::new(
                    Code::InvalidValue,
                    &pointer,
                    format!("{} has no version {}", approved.id, version_text(version)),
                )
            })
            .collect::<Vec<_>>();

        other_interface.into_iter().chain(missing)
    });

    head.into_iter().chain(approvals).collect()
}

pub fn version_text(version: &SemverV1) -> String {
    format!("{}.{}.{}", version.major.get(), version.minor.get(), version.patch.get())
}

fn object(text: &str) -> Result<Map<String, Value>, Report> {
    let invalid =
        |message: String| Report { diagnostics: vec![Diagnostic::new(Code::InvalidJson, "", message)], syntax: None };

    match serde_json::from_str::<Value>(text).map_err(|error| invalid(error.to_string()))? {
        Value::Object(object) => Ok(object),
        _ => Err(invalid("the file is not a JSON object".into())),
    }
}

fn unknown_keys(object: &Map<String, Value>, allowed: &[&str]) -> Vec<Diagnostic> {
    object
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .map(|key| Diagnostic::new(Code::UnknownKey, &format!("/{key}"), format!("unknown key `{key}`")))
        .collect()
}

fn optional_address(object: &Map<String, Value>, key: &str, findings: &mut Vec<Diagnostic>) -> Option<Address> {
    let value = object.get(key)?;
    let decoded =
        value.as_str().and_then(|text| bs58::decode(text).into_vec().ok()).and_then(|bytes| bytes.try_into().ok());

    if decoded.is_none() {
        findings.push(Diagnostic::new(
            Code::InvalidValue,
            &format!("/{key}"),
            format!("`{key}` is not a base58 address"),
        ));
    }

    decoded.map(Address)
}

fn version(value: &Value, pointer: &str, findings: &mut Vec<Diagnostic>) -> Option<SemverV1> {
    let parsed = value.as_str().ok_or_else(|| "a version is a string".to_owned()).and_then(parse_version);

    parsed.map_err(|reason| findings.push(Diagnostic::new(Code::InvalidValue, pointer, reason))).ok()
}

fn approvals(value: &Value, findings: &mut Vec<Diagnostic>) -> Vec<ApprovedImplementation> {
    let Some(object) = value.as_object() else {
        findings.push(Diagnostic::new(
            Code::WrongType,
            "/approvals",
            "`approvals` maps implementation ids to versions",
        ));
        return Vec::new();
    };

    object
        .iter()
        .filter_map(|(text, versions)| {
            let pointer = format!("/approvals/{text}");
            let id = Id::parse(text)
                .map_err(|reason| findings.push(Diagnostic::new(Code::InvalidValue, &pointer, reason)))
                .ok()?;
            let Some(list) = versions.as_array() else {
                findings.push(Diagnostic::new(Code::WrongType, &pointer, "the approved versions are a list"));
                return None;
            };
            let versions = list.iter().filter_map(|version| self::version(version, &pointer, findings)).collect();

            Some(ApprovedImplementation { id, versions })
        })
        .collect()
}

fn finish<T>(findings: Vec<Diagnostic>, settings: T) -> Result<T, Report> {
    match findings.is_empty() {
        true => Ok(settings),
        false => Err(Report { diagnostics: findings, syntax: None }),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::lint::compile_tree;

    fn index(kind: Kind, name: &str, text: &str) -> IndexFile {
        IndexFile {
            path: PathBuf::from("index.json"),
            organization: "solana.org".into(),
            kind,
            name: name.into(),
            text: text.into(),
        }
    }

    fn codes(report: &Report) -> Vec<Code> {
        report.codes()
    }

    #[test]
    fn an_implementation_index_holds_no_approvals() {
        let file = index(Kind::Implementation, "system-transfer", r#"{ "head": "1.0.0", "approvals": {} }"#);

        assert_eq!(read_index(&file).err().map(|report| codes(&report)), Some(vec![Code::UnknownKey]));
    }

    #[test]
    fn reads_the_authorities_and_the_head() {
        let file = index(
            Kind::Interface,
            "token.transfer",
            r#"{ "updateAuthority": "11111111111111111111111111111112", "head": "1.0.0", "approveNewVersions": true }"#,
        );
        let settings = read_index(&file).ok().unwrap();

        let mut one = [0; 32];
        one[31] = 1;

        assert_eq!(settings.update_authority, Address(one));
        assert_eq!(settings.approve_authority, Address::default());
        assert!(settings.approve_new_versions);
        assert_eq!(settings.head.map(|head| version_text(&head)), Some("1.0.0".to_owned()));
    }

    /// An approval must name an implementation of this interface, at a version in the tree, and a
    /// head must name a version in the tree.
    #[test]
    fn checks_the_versions_and_the_implementations_that_an_index_names() {
        let tree =
            crate::tree::Tree::read(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../definitions")).unwrap();
        let compiled = compile_tree(&tree);
        let file = index(
            Kind::Interface,
            "token.transfer",
            r#"{ "head": "2.0.0", "approvals": { "solana.org/kamino-deposit": ["1.0.0"], "solana.org/system-transfer": ["9.0.0"] } }"#,
        );

        let findings = check_references(&read_index(&file).ok().unwrap(), &compiled.catalog);
        let messages: Vec<_> = findings.iter().map(|finding| finding.message.as_str()).collect();

        assert_eq!(
            messages,
            [
                "solana.org/token.transfer has no version 2.0.0",
                "solana.org/kamino-deposit is no implementation of solana.org/token.transfer",
                "solana.org/system-transfer has no version 9.0.0",
            ]
        );
    }
}
