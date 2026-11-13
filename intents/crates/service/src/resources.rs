//! The registry as JSON resources: organizations, interfaces, implementations, and each published
//! version with its document in the definition format that `intents/definitions` uses.
//!
//! A list reads two `getProgramAccounts` calls, filtered by discriminator, and one
//! `getMultipleAccounts` call for the documents that name each index. A single index or version
//! reads only the addresses that its organization, name, and version derive.

use std::collections::HashMap;

use base64::Engine as _;
use serde_json::{json, Value};

use sdp_intents_chain::{CachedRpc, Freshness, ProgramAccount};
use sdp_intents_compiler::{decompile_implementation, decompile_interface, format_version, Id, Organizations};
use sdp_intents_registry_client::{
    version_address, IndexView, OrganizationView, VersionEntry, INDEX_DISCRIMINATOR, ORGANIZATION_DISCRIMINATOR,
    REGISTRY_PROGRAM,
};
use sdp_intents_spec::wire::{DocumentKind, SemverV1};
use sdp_intents_spec::{Address, Implementation, Interface};

use crate::describe::base58;
use crate::error::ServiceError;
use crate::registry::{released, IndexKey, Registry, VersionChoice};

/// Every organization and index that the registry holds, with the name of each index.
struct Snapshot {
    organizations: Vec<ProgramAccount>,
    indexes: Vec<NamedIndex>,
}

struct NamedIndex {
    address: Address,
    data: Vec<u8>,
    id: Option<Id>,
}

/// `GET /v1/registry`: every organization, interface, and implementation, without documents.
pub async fn registry(chain: &CachedRpc) -> Result<Value, ServiceError> {
    let snapshot = Snapshot::read(chain).await?;

    Ok(json!({
        "organizations": snapshot.organizations(),
        "interfaces": snapshot.summaries(DocumentKind::Interface, None),
        "implementations": snapshot.summaries(DocumentKind::Implementation, None),
    }))
}

pub async fn organizations(chain: &CachedRpc) -> Result<Value, ServiceError> {
    let organizations = chain.program_accounts(&REGISTRY_PROGRAM, &ORGANIZATION_DISCRIMINATOR).await?;

    Ok(json!({ "organizations": organizations.iter().filter_map(organization_json).collect::<Vec<_>>() }))
}

pub async fn kind_list(chain: &CachedRpc, kind: DocumentKind) -> Result<Value, ServiceError> {
    let snapshot = Snapshot::read(chain).await?;

    Ok(json!({ list_key(kind): snapshot.summaries(kind, None) }))
}

/// The implementations of one interface, approved or not, each with whether the interface approves it.
pub async fn implementations_of(chain: &CachedRpc, interface: &Id) -> Result<Value, ServiceError> {
    let index = Registry { chain }.indexes(vec![IndexKey::interface(interface)]).await?;
    let address =
        index.first().map(|index| index.address).ok_or_else(|| unknown(DocumentKind::Interface, interface))?;
    let snapshot = Snapshot::read(chain).await?;

    Ok(json!({ "implementations": snapshot.summaries(DocumentKind::Implementation, Some(&address)) }))
}

/// One interface or implementation index, by its id.
pub async fn index(chain: &CachedRpc, key: IndexKey) -> Result<Value, ServiceError> {
    let id = key.id.clone();
    let kind = key.kind;
    let index = Registry { chain }.indexes(vec![key]).await?.pop().ok_or_else(|| unknown(kind, &id))?;
    let view = index.view()?;

    if kind == DocumentKind::Interface {
        return Ok(interface_summary(&id, &index.address, &view));
    }

    let interface = interface_of(chain, &view, &index.address).await?;

    Ok(implementation_summary(&id, &index.address, &view, interface.as_ref()))
}

/// The interface that an implementation index names: its id, and whether it approves the index.
struct NamedInterface {
    id: Id,
    approves: bool,
}

/// `implementation_address` is the implementation index, which the interface's approved list names.
async fn interface_of(
    chain: &CachedRpc,
    implementation: &IndexView<'_>,
    implementation_address: &Address,
) -> Result<Option<NamedInterface>, ServiceError> {
    let interface_address = *implementation.interface();
    let Some(Some(account)) = chain.accounts(&[interface_address], Freshness::Live).await?.into_iter().next() else {
        return Ok(None);
    };

    let Ok(view) = IndexView::parse(&account.data) else { return Ok(None) };
    let Some(entry) = shown(&view) else { return Ok(None) };

    let choice = VersionChoice::of(&view, &entry)?;
    let reads = [choice.address()?, *view.organization()];
    let mut accounts = chain.accounts(&reads, Freshness::Published).await?.into_iter();
    let document = choice.document(accounts.next().flatten())?;
    let organization = accounts.next().flatten().and_then(|account| organization_name(&account.data));

    let name = Interface::parse(&document).ok().and_then(|interface| interface.name().ok().map(text));
    let id = organization.zip(name).map(|(organization, name)| Id { organization, name });

    Ok(id.map(|id| NamedInterface { id, approves: view.approves(implementation_address) }))
}

/// One published version, with its document as JSON and as the registry's bytes.
pub async fn version(chain: &CachedRpc, key: IndexKey, version: SemverV1) -> Result<Value, ServiceError> {
    let id = key.id.clone();
    let kind = key.kind;
    let index = Registry { chain }.indexes(vec![key]).await?.pop().ok_or_else(|| unknown(kind, &id))?;
    let view = index.view()?;
    let entry = view.entry(&version).ok_or_else(|| no_version(&id, version))?;

    if entry.removed {
        return Err(ServiceError::refused("removed", format!("{id}@{} was removed", format_version(version))));
    }

    let choice = VersionChoice::of(&view, &entry)?;
    let address = choice.address()?;
    let bytes = Registry { chain }.documents(&[choice]).await?.pop().ok_or_else(|| no_version(&id, version))?;
    let document = match kind {
        DocumentKind::Interface => interface_document(&bytes, &id, &view)?,
        _ => implementation_document(chain, &bytes, &id, &view).await?,
    };

    Ok(json!({
        "id": id.to_string(),
        "version": format_version(version),
        "address": base58(&address),
        "publishSlot": entry.publish_slot.to_string(),
        "approved": entry.approved,
        "removed": entry.removed,
        "tier": entry.tier,
        "document": document,
        "bytes": base64(&bytes),
    }))
}

fn interface_document(bytes: &[u8], id: &Id, view: &IndexView<'_>) -> Result<Value, ServiceError> {
    let organizations = Organizations::from([(*view.organization(), id.organization.clone())]);

    decompile_interface(bytes, &organizations).map_err(|error| ServiceError::refused("badDocument", error.to_string()))
}

/// An implementation names its interface's inputs by position, so the interface version that it
/// implements is read with it, and the organization of that interface for its id.
async fn implementation_document(
    chain: &CachedRpc,
    bytes: &[u8],
    id: &Id,
    view: &IndexView<'_>,
) -> Result<Value, ServiceError> {
    let implementation =
        Implementation::parse(bytes).map_err(|error| ServiceError::refused("badDocument", error.to_string()))?;
    let implements = implementation.implements();
    let interface_address =
        version_address(DocumentKind::Interface, &implements.publisher, &implements.name_hash, &implements.version)
            .map_err(|error| ServiceError::invalid_request(error.to_string()))?;

    let reads = [interface_address, implements.publisher];
    let mut accounts = chain.accounts(&reads, Freshness::Published).await?.into_iter();
    let interface_choice = VersionChoice {
        kind: DocumentKind::Interface,
        organization: implements.publisher,
        name_hash: implements.name_hash,
        version: implements.version,
    };
    let interface = interface_choice.document(accounts.next().flatten())?;
    let publisher = accounts.next().flatten().and_then(|account| organization_name(&account.data));

    let organizations: Organizations = [(*view.organization(), id.organization.clone())]
        .into_iter()
        .chain(publisher.map(|name| (implements.publisher, name)))
        .collect();

    decompile_implementation(bytes, &interface, &organizations)
        .map_err(|error| ServiceError::refused("badDocument", error.to_string()))
}

impl Snapshot {
    /// The organizations and indexes, then one read of the document that names each index.
    async fn read(chain: &CachedRpc) -> Result<Self, ServiceError> {
        let organizations = chain.program_accounts(&REGISTRY_PROGRAM, &ORGANIZATION_DISCRIMINATOR).await?;
        let indexes = chain.program_accounts(&REGISTRY_PROGRAM, &INDEX_DISCRIMINATOR).await?;
        let names: HashMap<Address, String> = organizations
            .iter()
            .filter_map(|listed| Some((listed.address, organization_name(&listed.account.data)?)))
            .collect();

        let choices: Vec<Option<VersionChoice>> = indexes
            .iter()
            .map(|index| {
                let view = IndexView::parse(&index.account.data).ok()?;

                VersionChoice::of(&view, &shown(&view)?).ok()
            })
            .collect();
        let documents = documents(chain, &choices).await?;

        let named = indexes
            .into_iter()
            .zip(documents)
            .map(|(index, document)| {
                let organization =
                    IndexView::parse(&index.account.data).ok().and_then(|view| names.get(view.organization()).cloned());
                let name = document.as_deref().and_then(document_name);
                let id = organization.zip(name).map(|(organization, name)| Id { organization, name });

                NamedIndex { address: index.address, data: index.account.data, id }
            })
            .collect();

        Ok(Self { organizations, indexes: named })
    }

    fn organizations(&self) -> Vec<Value> {
        self.organizations.iter().filter_map(organization_json).collect()
    }

    /// Each index of `kind` that has a name. With `interface`, only the implementations of it.
    fn summaries(&self, kind: DocumentKind, interface: Option<&Address>) -> Vec<Value> {
        self.indexes
            .iter()
            .filter_map(|index| Some((index, IndexView::parse(&index.data).ok()?, index.id.as_ref()?)))
            .filter(|(_, view, _)| view.kind() == Ok(kind))
            .filter(|(_, view, _)| interface.is_none_or(|address| view.interface() == address))
            .map(|(index, view, id)| match kind {
                DocumentKind::Interface => interface_summary(id, &index.address, &view),
                _ => implementation_summary(id, &index.address, &view, self.interface(&view, &index.address).as_ref()),
            })
            .collect()
    }

    fn interface(&self, implementation: &IndexView<'_>, implementation_address: &Address) -> Option<NamedInterface> {
        let interface = self.indexes.iter().find(|index| index.address == *implementation.interface())?;
        let view = IndexView::parse(&interface.data).ok()?;

        Some(NamedInterface { id: interface.id.clone()?, approves: view.approves(implementation_address) })
    }
}

/// The document of each choice, in one call. A choice that is `None` reads nothing.
async fn documents(chain: &CachedRpc, choices: &[Option<VersionChoice>]) -> Result<Vec<Option<Vec<u8>>>, ServiceError> {
    let present: Vec<VersionChoice> = choices.iter().flatten().cloned().collect();
    let mut read = Registry { chain }.documents(&present).await?.into_iter();

    Ok(choices.iter().map(|choice| choice.as_ref().and_then(|_| read.next())).collect())
}

fn interface_summary(id: &Id, address: &Address, view: &IndexView<'_>) -> Value {
    json!({
        "id": id.to_string(),
        "organization": id.organization,
        "name": id.name,
        "address": base58(address),
        "head": view.head().map(format_version),
        "versions": view.versions().map(version_json).collect::<Vec<_>>(),
        "updateAuthority": base58(view.update_authority()),
        "approveAuthority": base58(view.approve_authority()),
        "approveNewVersions": view.approve_new_versions(),
    })
}

fn implementation_summary(
    id: &Id,
    address: &Address,
    view: &IndexView<'_>,
    interface: Option<&NamedInterface>,
) -> Value {
    json!({
        "id": id.to_string(),
        "organization": id.organization,
        "name": id.name,
        "address": base58(address),
        "interface": interface.map(|interface| interface.id.to_string()),
        "approved": interface.is_some_and(|interface| interface.approves),
        "head": view.head().map(format_version),
        "versions": view.versions().map(version_json).collect::<Vec<_>>(),
        "updateAuthority": base58(view.update_authority()),
    })
}

/// The head, or the newest version that is not removed when the index has no head.
fn shown(view: &IndexView<'_>) -> Option<VersionEntry> {
    released(view).or_else(|| view.versions().filter(|entry| !entry.removed).last())
}

fn document_name(document: &[u8]) -> Option<String> {
    let name = match Interface::parse(document) {
        Ok(interface) => interface.name().ok(),
        Err(_) => Implementation::parse(document).ok()?.name().ok(),
    };

    name.map(text)
}

fn organization_json(listed: &ProgramAccount) -> Option<Value> {
    let view = OrganizationView::parse(&listed.account.data).ok()?;

    Some(
        json!({ "name": view.name().ok()?, "address": base58(&listed.address), "authority": base58(view.authority()) }),
    )
}

fn organization_name(data: &[u8]) -> Option<String> {
    OrganizationView::parse(data).ok()?.name().ok().map(str::to_owned)
}

fn version_json(entry: VersionEntry) -> Value {
    json!({
        "version": format_version(entry.version),
        "publishSlot": entry.publish_slot.to_string(),
        "approved": entry.approved,
        "removed": entry.removed,
        "tier": entry.tier,
    })
}

fn list_key(kind: DocumentKind) -> &'static str {
    if kind == DocumentKind::Interface {
        "interfaces"
    } else {
        "implementations"
    }
}

fn unknown(kind: DocumentKind, id: &Id) -> ServiceError {
    let (code, noun) = match kind {
        DocumentKind::Interface => ("unknownInterface", "interface"),
        _ => ("unknownImplementation", "implementation"),
    };

    ServiceError::not_found(code, format!("the registry holds no {noun} `{id}`"))
}

fn no_version(id: &Id, version: SemverV1) -> ServiceError {
    ServiceError::not_found("noVersion", format!("the registry holds no version {} of {id}", format_version(version)))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
