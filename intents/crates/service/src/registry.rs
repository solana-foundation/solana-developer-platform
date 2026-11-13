//! Reads the registry through the cache. Indexes are live reads under a subscription. Version
//! accounts are published copies, because a version never changes while it exists, and the live
//! index that lists it is read first.

use std::cmp::Ordering;

use sdp_intents_chain::{CachedRpc, Freshness};
use sdp_intents_compiler::diagnostic::Report;
use sdp_intents_compiler::{format_version, Catalog, Id, IdRange};
use sdp_intents_planner::Account;
use sdp_intents_registry_client::{
    index_address, name_hash, organization_address, version_address, IndexView, VersionEntry,
    IMPLEMENTATION_DISCRIMINATOR, INTERFACE_DISCRIMINATOR, REGISTRY_PROGRAM, VERSION_DOCUMENT_OFFSET,
};
use sdp_intents_spec::wire::{DocumentKind, SemverV1};
use sdp_intents_spec::Address;

use crate::error::ServiceError;

/// One interface or implementation, by its id.
#[derive(Clone, Debug)]
pub struct IndexKey {
    pub kind: DocumentKind,
    pub id: Id,
}

/// An index account that the registry owns.
pub struct IndexAccount {
    pub key: IndexKey,
    pub address: Address,
    pub data: Vec<u8>,
}

/// A version account to read.
pub struct VersionChoice {
    pub kind: DocumentKind,
    pub organization: Address,
    pub name_hash: [u8; 32],
    pub version: SemverV1,
}

/// A published document, with the name of its organization.
#[derive(Clone, Debug)]
pub struct Document {
    pub organization: String,
    pub kind: DocumentKind,
    pub bytes: Vec<u8>,
}

/// What one intent of a request names.
pub struct IntentReference {
    pub interface: IdRange,
    pub implementation: IdRange,
    pub allow_unapproved: bool,
}

/// The two documents of one intent.
pub struct IntentDocuments {
    pub interface: Document,
    pub implementation: Document,
}

pub struct Registry<'s> {
    pub chain: &'s CachedRpc,
}

impl IndexKey {
    pub fn interface(id: &Id) -> Self {
        Self { kind: DocumentKind::Interface, id: id.clone() }
    }

    pub fn implementation(id: &Id) -> Self {
        Self { kind: DocumentKind::Implementation, id: id.clone() }
    }

    pub fn organization(&self) -> Result<Address, ServiceError> {
        organization_address(&self.id.organization).map_err(|error| ServiceError::invalid_request(error.to_string()))
    }

    pub fn address(&self) -> Result<Address, ServiceError> {
        index_address(self.kind, &self.organization()?, &name_hash(&self.id.name))
            .map_err(|error| ServiceError::invalid_request(error.to_string()))
    }

    fn kind_text(&self) -> &'static str {
        match self.kind {
            DocumentKind::Interface => "interface",
            _ => "implementation",
        }
    }
}

impl IndexAccount {
    pub fn view(&self) -> Result<IndexView<'_>, ServiceError> {
        IndexView::parse(&self.data).map_err(|error| ServiceError::refused("wrongAccount", error.to_string()))
    }
}

impl VersionChoice {
    pub fn of(index: &IndexView<'_>, entry: &VersionEntry) -> Result<Self, ServiceError> {
        let kind = index.kind().map_err(|error| ServiceError::refused("wrongAccount", error.to_string()))?;

        Ok(Self { kind, organization: *index.organization(), name_hash: *index.name_hash(), version: entry.version })
    }

    pub fn address(&self) -> Result<Address, ServiceError> {
        version_address(self.kind, &self.organization, &self.name_hash, &self.version)
            .map_err(|error| ServiceError::invalid_request(error.to_string()))
    }

    /// The document of the version account, which the registry must own.
    pub fn document(&self, account: Option<Account>) -> Result<Vec<u8>, ServiceError> {
        let discriminator =
            if self.kind == DocumentKind::Interface { INTERFACE_DISCRIMINATOR } else { IMPLEMENTATION_DISCRIMINATOR };

        account
            .filter(|account| account.owner == REGISTRY_PROGRAM && account.data.starts_with(&discriminator))
            .and_then(|account| account.data.get(VERSION_DOCUMENT_OFFSET..).map(<[u8]>::to_vec))
            .ok_or_else(|| {
                ServiceError::not_found(
                    "noDocument",
                    format!("the registry holds no document at version {}", format_version(self.version)),
                )
            })
    }
}

impl Registry<'_> {
    /// Each index, in one call. Each one read stays under a subscription after.
    pub async fn indexes(&self, keys: Vec<IndexKey>) -> Result<Vec<IndexAccount>, ServiceError> {
        let addresses = keys.iter().map(IndexKey::address).collect::<Result<Vec<_>, _>>()?;
        let accounts = self.chain.accounts(&addresses, Freshness::Live).await?;
        addresses.iter().for_each(|address| self.chain.subscribe(*address));

        keys.into_iter()
            .zip(addresses)
            .zip(accounts)
            .map(|((key, address), account)| {
                let Some(account) = account.filter(|account| account.owner == REGISTRY_PROGRAM) else {
                    let code =
                        if key.kind == DocumentKind::Interface { "unknownInterface" } else { "unknownImplementation" };

                    return Err(ServiceError::not_found(
                        code,
                        format!("the registry holds no {} `{}`", key.kind_text(), key.id),
                    ));
                };

                Ok(IndexAccount { key, address, data: account.data })
            })
            .collect()
    }

    /// The document of each version, in one call.
    pub async fn documents(&self, versions: &[VersionChoice]) -> Result<Vec<Vec<u8>>, ServiceError> {
        let addresses = versions.iter().map(VersionChoice::address).collect::<Result<Vec<_>, _>>()?;
        let accounts = self.chain.accounts(&addresses, Freshness::Published).await?;

        versions.iter().zip(accounts).map(|(choice, account)| choice.document(account)).collect()
    }

    /// The documents of each intent: one call for the indexes, then one for the versions.
    pub async fn intent_documents(&self, references: &[IntentReference]) -> Result<Vec<IntentDocuments>, ServiceError> {
        let keys = references
            .iter()
            .flat_map(|reference| {
                [IndexKey::interface(&reference.interface.id), IndexKey::implementation(&reference.implementation.id)]
            })
            .collect();
        let indexes = self.indexes(keys).await?;

        let choices = references
            .iter()
            .zip(indexes.as_chunks::<2>().0)
            .map(|(reference, [interface, implementation])| choose(reference, interface, implementation))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();

        let documents = self.documents(&choices).await?;
        let document = |organization: &Id, kind, bytes: &Vec<u8>| Document {
            organization: organization.organization.clone(),
            kind,
            bytes: bytes.clone(),
        };

        Ok(references
            .iter()
            .zip(documents.as_chunks::<2>().0)
            .map(|(reference, [interface, implementation])| IntentDocuments {
                interface: document(&reference.interface.id, DocumentKind::Interface, interface),
                implementation: document(&reference.implementation.id, DocumentKind::Implementation, implementation),
            })
            .collect())
    }
}

/// The versions of one intent. The implementation must be approved, unless the intent allows it.
fn choose(
    reference: &IntentReference,
    interface: &IndexAccount,
    implementation: &IndexAccount,
) -> Result<[VersionChoice; 2], ServiceError> {
    let interface_view = interface.view()?;
    let implementation_view = implementation.view()?;
    let interface_entry = pick(&interface_view, &reference.interface)?;
    let implementation_entry = pick(&implementation_view, &reference.implementation)?;
    let approved = interface_view.approves(&implementation.address) && implementation_entry.approved;

    if !approved && !reference.allow_unapproved {
        return Err(ServiceError::refused(
            "notApproved",
            format!(
                "{}@{} is not approved for {}. Set `options.allowUnapproved` to use it.",
                implementation.key.id,
                format_version(implementation_entry.version),
                interface.key.id,
            ),
        ));
    }

    Ok([
        VersionChoice::of(&interface_view, &interface_entry)?,
        VersionChoice::of(&implementation_view, &implementation_entry)?,
    ])
}

/// The version that `range` resolves to: the highest that it covers, that is not removed, and
/// that is not above the head. An exact version can be above the head, so that a publisher can test
/// it before `set_head`.
pub fn pick(index: &IndexView<'_>, range: &IdRange) -> Result<VersionEntry, ServiceError> {
    let head = index.head();
    let released = |entry: &VersionEntry| {
        range.exact || head.is_some_and(|head| compare(&entry.version, &head) != Ordering::Greater)
    };
    let highest = index
        .versions()
        .filter(|entry| range.covers(entry.version) && released(entry))
        .filter(|entry| !entry.removed)
        .last();

    match highest {
        Some(entry) => Ok(entry),
        None if range.exact && index.entry(&range.lowest).is_some_and(|entry| entry.removed) => {
            Err(ServiceError::refused("removed", format!("{}@{} was removed", range.id, format_version(range.lowest))))
        }
        None => Err(ServiceError::refused("noVersion", format!("no released version of {} is in the range", range.id))),
    }
}

/// The highest released version, for a caller that names no range.
pub fn released(index: &IndexView<'_>) -> Option<VersionEntry> {
    let head = index.head()?;

    index.versions().filter(|entry| !entry.removed && compare(&entry.version, &head) != Ordering::Greater).last()
}

pub fn compare(left: &SemverV1, right: &SemverV1) -> Ordering {
    let parts = |version: &SemverV1| (version.major.get(), version.minor.get(), version.patch.get());

    parts(left).cmp(&parts(right))
}

/// A catalog of `documents`, with the address of each organization that publishes one.
pub fn catalog<'d>(documents: impl IntoIterator<Item = &'d Document> + Clone) -> Result<Catalog, ServiceError> {
    let mut catalog = documents.clone().into_iter().try_fold(Catalog::default(), |catalog, document| {
        let address = organization_address(&document.organization)
            .map_err(|error| ServiceError::invalid_request(error.to_string()))?;

        Ok::<_, ServiceError>(catalog.with_publisher(&document.organization, address))
    })?;

    for document in documents {
        let inserted = match document.kind {
            DocumentKind::Interface => {
                catalog.insert_interface(&document.organization, document.bytes.clone()).map(|_| ())
            }
            _ => catalog.insert_implementation(&document.organization, document.bytes.clone()).map(|_| ()),
        };

        inserted.map_err(|error| ServiceError::refused("wrongDocument", error.to_string()))?;
    }

    Ok(catalog)
}

/// The first finding of a report, for a short reason.
pub fn first_finding(report: &Report) -> String {
    report
        .diagnostics
        .first()
        .map(|finding| finding.message.clone())
        .unwrap_or_else(|| "the intent does not compile".to_owned())
}

#[cfg(test)]
mod tests {
    use sdp_intents_registry_client::INDEX_DISCRIMINATOR;
    use sdp_intents_spec::wire::PodU16;

    use super::*;

    fn semver(major: u16, minor: u16, patch: u16) -> SemverV1 {
        SemverV1 { major: PodU16::new(major), minor: PodU16::new(minor), patch: PodU16::new(patch) }
    }

    /// An index account, in the layout that the registry writes: the fixed part, then one 16-byte
    /// entry for each version, oldest first. Each version is `(version, removed)`.
    fn index(head: Option<SemverV1>, versions: &[(SemverV1, bool)]) -> Vec<u8> {
        let semver_bytes = |version: SemverV1| [version.major.0, version.minor.0, version.patch.0].concat();
        let fixed = [
            &INDEX_DISCRIMINATOR[..],
            &[u8::from(DocumentKind::Interface)],
            &[0; 32 * 5],
            &[0, u8::from(head.is_some())],
            &semver_bytes(head.unwrap_or(semver(0, 0, 0))),
            &u32::try_from(versions.len()).unwrap().to_le_bytes(),
            &0u32.to_le_bytes(),
        ]
        .concat();
        let entries = versions.iter().flat_map(|(version, removed)| {
            [semver_bytes(*version), 7u64.to_le_bytes().to_vec(), vec![1, u8::from(*removed)]].concat()
        });

        fixed.into_iter().chain(entries).collect()
    }

    fn resolve(data: &[u8], range: &str) -> Result<String, &'static str> {
        let range = IdRange::parse(&format!("solana.org/token.transfer@{range}")).unwrap();

        pick(&IndexView::parse(data).unwrap(), &range)
            .map(|entry| format_version(entry.version))
            .map_err(|error| error.code)
    }

    #[test]
    fn a_range_resolves_to_the_highest_version_up_to_the_head() {
        let data = index(
            Some(semver(1, 1, 0)),
            &[(semver(1, 0, 0), false), (semver(1, 1, 0), false), (semver(1, 2, 0), false)],
        );

        assert_eq!(resolve(&data, "^1"), Ok("1.1.0".to_owned()));
        assert_eq!(resolve(&data, "^1.2"), Err("noVersion"));
        assert_eq!(resolve(&data, "1.2.0"), Ok("1.2.0".to_owned()));
    }

    #[test]
    fn a_range_skips_a_removed_version_and_an_exact_version_refuses_it() {
        let data = index(
            Some(semver(1, 1, 0)),
            &[(semver(1, 0, 0), false), (semver(1, 0, 1), true), (semver(1, 1, 0), false)],
        );

        assert_eq!(resolve(&data, "^1.0.1"), Ok("1.1.0".to_owned()));
        assert_eq!(resolve(&data, "1.0.1"), Err("removed"));
    }

    #[test]
    fn an_index_with_no_head_releases_nothing() {
        let data = index(None, &[(semver(1, 0, 0), false)]);

        assert_eq!(resolve(&data, "^1"), Err("noVersion"));
        assert_eq!(resolve(&data, "1.0.0"), Ok("1.0.0".to_owned()));
        assert!(released(&IndexView::parse(&data).unwrap()).is_none());
    }
}
