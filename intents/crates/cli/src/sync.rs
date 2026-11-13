//! The steps that make the registry hold the definitions: create each organization and index,
//! publish each version, and set each interface's approvals. A step is planned only when the
//! registry does not hold its result, so `apply` can run again after a failure.
//!
//! The steps run in an order that the registry accepts: an interface version before the
//! implementations of it, and an implementation's approval before its versions, so that an
//! interface with `approveNewVersions` approves them at publish.

use std::collections::HashMap;

use sha2::{Digest as _, Sha256};

use sdp_intents_compiler::{Catalog, CompiledImplementation, CompiledInterface, Id};
use sdp_intents_planner::Account;
use sdp_intents_registry_client::{
    self as registry, Approval, IndexChange, IndexView, NewImplementation, OrganizationView, Publication,
    RegistryInstruction, VERSION_DOCUMENT_OFFSET,
};
use sdp_intents_spec::wire::{DocumentKind, SemverV1};
use sdp_intents_spec::Address;

use crate::lint::publisher;
use crate::tree::IndexFile;

/// A buffer write holds at most 800 bytes of the document, so the transaction stays under its size
/// limit.
const BUFFER_PART: usize = 800;

/// One change to the registry, and the transactions that make it, in order.
pub struct Step {
    pub description: String,
    pub transactions: Vec<Vec<RegistryInstruction>>,
}

/// What an interface's `index.json` states.
pub struct InterfaceApprovals {
    pub interface: Id,
    pub approve_new_versions: bool,
    pub implementations: Vec<ApprovedImplementation>,
}

pub struct ApprovedImplementation {
    pub id: Id,
    pub versions: Vec<SemverV1>,
}

/// The definitions, the accounts that the registry holds for them, and the key that signs.
pub struct Sync<'s> {
    pub catalog: &'s Catalog,
    pub approvals: &'s [InterfaceApprovals],
    pub accounts: &'s HashMap<Address, Account>,
    pub authority: Address,
}

/// A document's place in the registry.
struct Place {
    organization: Address,
    index: Address,
    version: Address,
}

impl Sync<'_> {
    /// Every account that the steps read: each organization, index, and version account.
    pub fn addresses(catalog: &Catalog) -> Result<Vec<Address>, String> {
        let interfaces = sorted_interfaces(catalog).into_iter().map(|interface| {
            place(DocumentKind::Interface, &interface.id, &interface.version)
                .map(|place| [place.organization, place.index, place.version])
        });
        let implementations = sorted_implementations(catalog).into_iter().map(|implementation| {
            place(DocumentKind::Implementation, &implementation.id, &implementation.version)
                .map(|place| [place.organization, place.index, place.version])
        });

        let addresses = interfaces.chain(implementations).collect::<Result<Vec<_>, _>>()?;

        Ok(addresses.into_iter().flatten().fold(Vec::new(), |mut unique, address| {
            if !unique.contains(&address) {
                unique.push(address);
            }

            unique
        }))
    }

    pub fn steps(&self) -> Result<Vec<Step>, String> {
        let interfaces = sorted_interfaces(self.catalog);
        let implementations = sorted_implementations(self.catalog);

        let organizations = self.organization_steps(&interfaces, &implementations)?;
        let interface_steps =
            interfaces.iter().map(|interface| self.interface_steps(interface)).collect::<Result<Vec<_>, _>>()?;
        let policies =
            self.approvals.iter().map(|approvals| self.policy_step(approvals)).collect::<Result<Vec<_>, _>>()?;
        let implementation_indexes = implementations
            .iter()
            .map(|implementation| self.implementation_index_step(implementation))
            .collect::<Result<Vec<_>, _>>()?;
        let approvals =
            self.approvals.iter().map(|approvals| self.approval_steps(approvals)).collect::<Result<Vec<_>, _>>()?;
        let versions = implementations
            .iter()
            .map(|implementation| self.implementation_version_step(implementation))
            .collect::<Result<Vec<_>, _>>()?;
        let version_approvals = self
            .approvals
            .iter()
            .map(|approvals| self.version_approval_steps(approvals))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(organizations
            .into_iter()
            .chain(interface_steps.into_iter().flatten())
            .chain(policies.into_iter().flatten())
            .chain(implementation_indexes.into_iter().flatten())
            .chain(approvals.into_iter().flatten())
            .chain(versions.into_iter().flatten())
            .chain(version_approvals.into_iter().flatten())
            .collect())
    }

    /// Each organization must exist with the signer as its authority.
    fn organization_steps(
        &self,
        interfaces: &[&CompiledInterface],
        implementations: &[&CompiledImplementation],
    ) -> Result<Vec<Step>, String> {
        let mut names: Vec<&str> = interfaces
            .iter()
            .map(|interface| interface.id.organization.as_str())
            .chain(implementations.iter().map(|implementation| implementation.id.organization.as_str()))
            .collect();
        names.sort_unstable();
        names.dedup();

        names
            .into_iter()
            .filter_map(|name| match self.accounts.get(&publisher(name)) {
                None => Some(
                    registry::create_organization(&self.authority, name, &self.authority)
                        .map(|instruction| step(format!("create the organization {name}"), vec![vec![instruction]]))
                        .map_err(|error| error.to_string()),
                ),
                Some(account) => self.check_authority(name, account).err().map(Err),
            })
            .collect()
    }

    fn check_authority(&self, name: &str, account: &Account) -> Result<(), String> {
        let organization = OrganizationView::parse(&account.data).map_err(|error| format!("{name}: {error}"))?;

        if *organization.authority() != self.authority {
            return Err(format!("the authority of {name} is another key than the signer"));
        }

        Ok(())
    }

    fn interface_steps(&self, interface: &CompiledInterface) -> Result<Vec<Step>, String> {
        let at = place(DocumentKind::Interface, &interface.id, &interface.version)?;
        let index = (!self.exists(&at.index)).then(|| {
            let instruction = registry::create_interface(
                &self.authority,
                &self.authority,
                &at.organization,
                &at.index,
                &interface.id.name_hash(),
            );

            step(format!("create the interface index {}", interface.id), vec![vec![instruction]])
        });
        let publish = self.publish_step(&interface.id, &interface.version, &interface.bytes, &at, None)?;

        Ok(index.into_iter().chain(publish).collect())
    }

    fn implementation_index_step(&self, implementation: &CompiledImplementation) -> Result<Option<Step>, String> {
        let at = place(DocumentKind::Implementation, &implementation.id, &implementation.version)?;

        if self.exists(&at.index) {
            return Ok(None);
        }

        let interface_index = implemented_index(implementation)?;
        let new = NewImplementation {
            payer: &self.authority,
            authority: &self.authority,
            organization: &at.organization,
            interface_index: &interface_index,
            index: &at.index,
        };
        let instruction = registry::create_implementation(&new, &implementation.id.name_hash());

        Ok(Some(step(format!("create the implementation index {}", implementation.id), vec![vec![instruction]])))
    }

    fn implementation_version_step(&self, implementation: &CompiledImplementation) -> Result<Option<Step>, String> {
        let at = place(DocumentKind::Implementation, &implementation.id, &implementation.version)?;
        let interface_index = implemented_index(implementation)?;

        self.publish_step(
            &implementation.id,
            &implementation.version,
            &implementation.bytes,
            &at,
            Some(interface_index),
        )
    }

    /// Writes the document to a buffer in parts, then publishes it. A version that the registry
    /// holds must hold the same document, because a version never changes.
    fn publish_step(
        &self,
        id: &Id,
        version: &SemverV1,
        document: &[u8],
        at: &Place,
        interface_index: Option<Address>,
    ) -> Result<Option<Step>, String> {
        let label = format!("{id}@{}", version_text(version));

        if let Some(account) = self.accounts.get(&at.version) {
            return match account.data.get(VERSION_DOCUMENT_OFFSET..) == Some(document) {
                true => Ok(None),
                false => Err(format!("the registry holds another document at {label}. Publish a new version.")),
            };
        }

        let document_hash: [u8; 32] = Sha256::digest(document).into();
        let buffer_id = document_hash.first_chunk::<4>().map_or(0, |bytes| u32::from_le_bytes(*bytes));
        let buffer = registry::buffer_address(&self.authority, buffer_id).map_err(|error| error.to_string())?;
        let writes = document
            .chunks(BUFFER_PART)
            .zip((0..).step_by(BUFFER_PART))
            .map(|(part, offset)| {
                registry::write_buffer(&self.authority, &buffer, buffer_id, document.len(), offset, part)
                    .map(|instruction| vec![instruction])
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let publication = Publication {
            payer: self.authority,
            authority: self.authority,
            organization: at.organization,
            index: at.index,
            buffer,
            buffer_writer: self.authority,
            version: at.version,
            interface_index,
        };

        let transactions = writes.into_iter().chain([vec![publication.instruction(&document_hash)]]).collect();

        Ok(Some(step(format!("publish {label}"), transactions)))
    }

    fn policy_step(&self, approvals: &InterfaceApprovals) -> Result<Option<Step>, String> {
        let index = index_of(DocumentKind::Interface, &approvals.interface)?;
        let current = self.index(&index)?.is_some_and(|view| view.approve_new_versions());

        if current == approvals.approve_new_versions {
            return Ok(None);
        }

        let change = IndexChange {
            authority: self.authority,
            organization: publisher(&approvals.interface.organization),
            index,
        };
        let instruction = change.set_approval_policy(approvals.approve_new_versions);

        Ok(Some(step(
            format!("set approveNewVersions of {} to {}", approvals.interface, approvals.approve_new_versions),
            vec![vec![instruction]],
        )))
    }

    fn approval_steps(&self, approvals: &InterfaceApprovals) -> Result<Vec<Step>, String> {
        let interface_index = index_of(DocumentKind::Interface, &approvals.interface)?;

        approvals
            .implementations
            .iter()
            .map(|implementation| {
                let approval = self.approval(approvals, &interface_index, &implementation.id)?;
                let approved =
                    self.index(&interface_index)?.is_some_and(|view| view.approves(&approval.implementation_index));

                Ok((!approved).then(|| {
                    step(
                        format!("approve {} for {}", implementation.id, approvals.interface),
                        vec![vec![approval.approve_implementation(&self.authority)]],
                    )
                }))
            })
            .filter_map(Result::transpose)
            .collect()
    }

    /// A version that is new and that the interface approves at publish needs no approval.
    fn version_approval_steps(&self, approvals: &InterfaceApprovals) -> Result<Vec<Step>, String> {
        let interface_index = index_of(DocumentKind::Interface, &approvals.interface)?;
        let mut steps = Vec::new();

        for implementation in &approvals.implementations {
            let approval = self.approval(approvals, &interface_index, &implementation.id)?;

            for version in &implementation.versions {
                let entry = self.index(&approval.implementation_index)?.and_then(|view| view.entry(version));
                let approved_at_publish = entry.is_none() && approvals.approve_new_versions;

                if entry.is_some_and(|entry| entry.approved) || approved_at_publish {
                    continue;
                }

                let description = format!("approve {}@{}", implementation.id, version_text(version));
                steps.push(step(description, vec![vec![approval.approve_version(version)]]));
            }
        }

        Ok(steps)
    }

    fn approval(
        &self,
        approvals: &InterfaceApprovals,
        interface_index: &Address,
        implementation: &Id,
    ) -> Result<Approval, String> {
        Ok(Approval {
            authority: self.authority,
            organization: publisher(&approvals.interface.organization),
            interface_index: *interface_index,
            implementation_index: index_of(DocumentKind::Implementation, implementation)?,
        })
    }

    /// The index at `address`, or `None` when the registry holds no index there.
    fn index(&self, address: &Address) -> Result<Option<IndexView<'_>>, String> {
        self.accounts
            .get(address)
            .map(|account| IndexView::parse(&account.data).map_err(|error| error.to_string()))
            .transpose()
    }

    fn exists(&self, address: &Address) -> bool {
        self.accounts.contains_key(address)
    }
}

fn step(description: String, transactions: Vec<Vec<RegistryInstruction>>) -> Step {
    Step { description, transactions }
}

fn place(kind: DocumentKind, id: &Id, version: &SemverV1) -> Result<Place, String> {
    let organization = publisher(&id.organization);
    let name_hash = id.name_hash();
    let error = |error: registry::RegistryError| error.to_string();

    Ok(Place {
        organization,
        index: registry::index_address(kind, &organization, &name_hash).map_err(error)?,
        version: registry::version_address(kind, &organization, &name_hash, version).map_err(error)?,
    })
}

fn index_of(kind: DocumentKind, id: &Id) -> Result<Address, String> {
    registry::index_address(kind, &publisher(&id.organization), &id.name_hash()).map_err(|error| error.to_string())
}

/// The index of the interface that the implementation implements.
fn implemented_index(implementation: &CompiledImplementation) -> Result<Address, String> {
    let implements = &implementation.implements;

    registry::index_address(DocumentKind::Interface, &implements.publisher, &implements.name_hash)
        .map_err(|error| error.to_string())
}

fn sorted_interfaces(catalog: &Catalog) -> Vec<&CompiledInterface> {
    let mut interfaces: Vec<_> = catalog.interfaces().collect();
    interfaces.sort_by_key(|interface| (interface.id.to_string(), version_key(&interface.version)));

    interfaces
}

fn sorted_implementations(catalog: &Catalog) -> Vec<&CompiledImplementation> {
    let mut implementations: Vec<_> = catalog.implementations().collect();
    implementations.sort_by_key(|implementation| (implementation.id.to_string(), version_key(&implementation.version)));

    implementations
}

fn version_key(version: &SemverV1) -> [u16; 3] {
    [version.major.get(), version.minor.get(), version.patch.get()]
}

fn version_text(version: &SemverV1) -> String {
    format!("{}.{}.{}", version.major.get(), version.minor.get(), version.patch.get())
}

/// Reads an interface's `index.json`: `approveNewVersions`, which defaults to false, and
/// `approvals`, a map from implementation id to its approved versions.
pub fn read_approvals(file: &IndexFile) -> Result<InterfaceApprovals, String> {
    let at = |reason: String| format!("{}: {reason}", file.path.display());
    let value: serde_json::Value = serde_json::from_str(&file.text).map_err(|error| at(error.to_string()))?;
    let object = value.as_object().ok_or_else(|| at("the index is not an object".into()))?;

    if let Some(key) = object.keys().find(|key| !["approveNewVersions", "approvals"].contains(&key.as_str())) {
        return Err(at(format!("unknown key `{key}`")));
    }

    let approve_new_versions = match object.get("approveNewVersions") {
        None => false,
        Some(value) => value.as_bool().ok_or_else(|| at("`approveNewVersions` is not a boolean".into()))?,
    };
    let approvals = object.get("approvals").and_then(|value| value.as_object());
    let implementations = approvals
        .into_iter()
        .flatten()
        .map(|(id, versions)| {
            let id = Id::parse(id).map_err(at)?;
            let versions = versions
                .as_array()
                .ok_or_else(|| at(format!("the versions of {id} are not a list")))?
                .iter()
                .map(|version| {
                    let text = version.as_str().ok_or_else(|| at(format!("a version of {id} is not a string")))?;

                    sdp_intents_compiler::parse_version(text).map_err(at)
                })
                .collect::<Result<Vec<_>, _>>()?;

            Ok(ApprovedImplementation { id, versions })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(InterfaceApprovals {
        interface: Id { organization: file.organization.clone(), name: file.interface.clone() },
        approve_new_versions,
        implementations,
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::lint::compile_tree;
    use crate::tree::Tree;

    fn definitions() -> Tree {
        Tree::read(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../definitions")).unwrap()
    }

    /// An empty registry needs the organization first, then each interface, then each
    /// implementation's index and approval before its version, and the version approvals last.
    #[test]
    fn plans_an_empty_registry_in_the_order_that_it_accepts() {
        let tree = definitions();
        let compiled = compile_tree(&tree);
        let approvals = tree.indexes.iter().map(read_approvals).collect::<Result<Vec<_>, _>>().unwrap();
        let accounts = HashMap::new();
        let sync = Sync {
            catalog: &compiled.catalog,
            approvals: &approvals,
            accounts: &accounts,
            authority: Address([1; 32]),
        };

        let steps: Vec<String> = sync.steps().unwrap().into_iter().map(|step| step.description).collect();
        let position = |text: &str| steps.iter().position(|step| step == text).unwrap();

        assert_eq!(steps.first().map(String::as_str), Some("create the organization solana.org"));
        assert!(
            position("publish solana.org/token.transfer@1.0.0")
                < position("create the implementation index solana.org/system-transfer")
        );
        assert!(
            position("approve solana.org/system-transfer for solana.org/token.transfer")
                < position("publish solana.org/system-transfer@1.0.0")
        );
        assert_eq!(steps.last().map(String::as_str), Some("approve solana.org/kamino-withdraw@1.0.0"));
        assert_eq!(steps.len(), 35);
    }

    #[test]
    fn refuses_an_unknown_key_in_an_index() {
        let file = IndexFile {
            path: PathBuf::from("index.json"),
            organization: "solana.org".into(),
            interface: "token.transfer".into(),
            text: r#"{ "approvals": {}, "head": "1.0.0" }"#.into(),
        };

        assert!(read_approvals(&file).is_err_and(|error| error.contains("unknown key `head`")));
    }
}
