//! The registry as a UI shows it: every organization, interface, and implementation, each index at
//! its head, or at its newest version when it has no head. Two `getProgramAccounts` calls, filtered
//! by discriminator, list the accounts. One `getMultipleAccounts` call reads the documents, which
//! the cache keeps.

use std::collections::HashMap;

use base64::Engine as _;
use serde_json::{json, Value};

use sdp_intents_chain::{CachedRpc, ProgramAccount};
use sdp_intents_compiler::format_version;
use sdp_intents_registry_client::{
    IndexView, OrganizationView, VersionEntry, INDEX_DISCRIMINATOR, ORGANIZATION_DISCRIMINATOR, REGISTRY_PROGRAM,
};
use sdp_intents_spec::wire::DocumentKind;
use sdp_intents_spec::{Address, Implementation, Interface};

use crate::describe::{self, base58, Names};
use crate::error::ServiceError;
use crate::registry::{Registry, VersionChoice};

/// A document's name, and the document as `describe` writes it.
struct Described {
    name: String,
    document: Value,
}

/// One index with the version that the listing shows.
struct Listed<'a> {
    address: Address,
    view: IndexView<'a>,
    shown: Option<VersionEntry>,
    document: Option<Vec<u8>>,
}

pub async fn listing(chain: &CachedRpc) -> Result<Value, ServiceError> {
    let organizations = chain.program_accounts(&REGISTRY_PROGRAM, &ORGANIZATION_DISCRIMINATOR).await?;
    let indexes = chain.program_accounts(&REGISTRY_PROGRAM, &INDEX_DISCRIMINATOR).await?;
    let names: HashMap<Address, String> = organizations
        .iter()
        .filter_map(|listed| {
            Some((listed.address, OrganizationView::parse(&listed.account.data).ok()?.name().ok()?.to_owned()))
        })
        .collect();

    let mut listed = indexes.iter().filter_map(listed).collect::<Vec<_>>();
    let choices = listed
        .iter()
        .filter_map(|index| index.shown.map(|entry| VersionChoice::of(&index.view, &entry)))
        .collect::<Result<Vec<_>, _>>()?;
    let mut documents = Registry { chain }.documents(&choices).await?.into_iter();

    for index in listed.iter_mut().filter(|index| index.shown.is_some()) {
        index.document = documents.next();
    }

    let interface_names: HashMap<Address, Names> = listed
        .iter()
        .filter(|index| index.view.kind() == Ok(DocumentKind::Interface))
        .filter_map(|index| {
            Some((index.address, Names::of_interface(&Interface::parse(index.document.as_deref()?).ok()?).ok()?))
        })
        .collect();
    let organization = |index: &Listed<'_>| {
        names.get(index.view.organization()).cloned().unwrap_or_else(|| base58(index.view.organization()))
    };

    let interfaces: Vec<Value> = listed
        .iter()
        .filter(|index| index.view.kind() == Ok(DocumentKind::Interface))
        .map(|index| interface_json(index, &organization(index)))
        .collect();
    let implementations: Vec<Value> = listed
        .iter()
        .filter(|index| index.view.kind() == Ok(DocumentKind::Implementation))
        .map(|index| implementation_json(index, &organization(index), &listed, &interface_names))
        .collect();
    let organizations: Vec<Value> = organizations.iter().filter_map(organization_json).collect();

    Ok(json!({ "organizations": organizations, "interfaces": interfaces, "implementations": implementations }))
}

fn listed(index: &ProgramAccount) -> Option<Listed<'_>> {
    let view = IndexView::parse(&index.account.data).ok()?;
    let head = view.head().and_then(|head| view.entry(&head)).filter(|entry| !entry.removed);
    let shown = head.or_else(|| view.versions().filter(|entry| !entry.removed).last());

    Some(Listed { address: index.address, view, shown, document: None })
}

fn organization_json(listed: &ProgramAccount) -> Option<Value> {
    let view = OrganizationView::parse(&listed.account.data).ok()?;

    Some(
        json!({ "name": view.name().ok()?, "address": base58(&listed.address), "authority": base58(view.authority()) }),
    )
}

fn interface_json(index: &Listed<'_>, organization: &str) -> Value {
    let described = index.document.as_deref().and_then(|bytes| {
        let view = Interface::parse(bytes).ok()?;
        let names = Names::of_interface(&view).ok()?;
        let name = String::from_utf8_lossy(view.name().ok()?).into_owned();

        Some(Described { name, document: describe::interface(&view, &names).ok()? })
    });

    json!({
        "id": described.as_ref().map(|described| format!("{organization}/{}", described.name)),
        "address": base58(&index.address),
        "organization": organization,
        "head": index.view.head().map(format_version),
        "approveNewVersions": index.view.approve_new_versions(),
        "updateAuthority": base58(index.view.update_authority()),
        "approveAuthority": base58(index.view.approve_authority()),
        "approved": index.view.approved().iter().map(base58).collect::<Vec<_>>(),
        "versions": index.view.versions().map(version_json).collect::<Vec<_>>(),
        "shown": index.shown.map(|entry| format_version(entry.version)),
        "document": described.map(|described| described.document),
        "bytes": index.document.as_deref().map(base64),
    })
}

fn implementation_json(
    index: &Listed<'_>,
    organization: &str,
    listed: &[Listed<'_>],
    names: &HashMap<Address, Names>,
) -> Value {
    let interface = listed.iter().find(|candidate| candidate.address == *index.view.interface());
    let described = index.document.as_deref().and_then(|bytes| {
        let view = Implementation::parse(bytes).ok()?;
        let names = names.get(index.view.interface()).cloned().unwrap_or_default().with_accounts(&view).ok()?;
        let name = String::from_utf8_lossy(view.name().ok()?).into_owned();

        Some(Described { name, document: describe::implementation(&view, &names).ok()? })
    });

    json!({
        "id": described.as_ref().map(|described| format!("{organization}/{}", described.name)),
        "address": base58(&index.address),
        "organization": organization,
        "interface": base58(index.view.interface()),
        "approved": interface.is_some_and(|interface| interface.view.approves(&index.address)),
        "head": index.view.head().map(format_version),
        "updateAuthority": base58(index.view.update_authority()),
        "versions": index.view.versions().map(version_json).collect::<Vec<_>>(),
        "shown": index.shown.map(|entry| format_version(entry.version)),
        "document": described.map(|described| described.document),
        "bytes": index.document.as_deref().map(base64),
    })
}

fn version_json(entry: VersionEntry) -> Value {
    json!({
        "version": format_version(entry.version),
        "publishSlot": entry.publish_slot.to_string(),
        "approved": entry.approved,
        "removed": entry.removed,
    })
}

fn base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
