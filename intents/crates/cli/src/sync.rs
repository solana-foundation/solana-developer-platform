//! The steps that make the registry hold the definitions: create each organization and index,
//! publish each version, set each interface's approvals, set each head, then move each authority. A
//! step is planned only when the registry does not hold its result, so `apply` can run again after a
//! failure.
//!
//! The steps run in an order that the registry accepts. An interface version comes before the
//! implementations of it. An implementation's approval comes before its versions, so that an
//! interface with `approveNewVersions` approves them at publish. Each organization and index is
//! created with the authority that runs `apply`, and the authorities that the files name move last,
//! because each earlier step needs that authority.
//!
//! The catalog holds one version of each id, so a step publishes at most one version of a document.

use std::collections::HashMap;

use sha2::{Digest as _, Sha256};

use sdp_intents_compiler::{Catalog, CompiledImplementation, CompiledInterface, Id};
use sdp_intents_planner::Account;
use sdp_intents_registry_client::{
    self as registry, Approval, IndexAuthorities, IndexChange, IndexView, NewImplementation, NewInterface,
    OrganizationView, Publication, RegistryInstruction, VERSION_DOCUMENT_OFFSET,
};
use sdp_intents_spec::wire::{DocumentKind, SemverV1};
use sdp_intents_spec::Address;

use crate::lint::publisher;
use crate::settings::{version_text, IndexSettings, OrganizationSettings};
use crate::tree::Kind;

/// A buffer write holds at most 800 bytes of the document, so the transaction stays under its size
/// limit.
const BUFFER_PART: usize = 800;

/// One change to the registry, and the transactions that make it, in order.
pub struct Step {
    pub description: String,
    pub transactions: Vec<StepTransaction>,
}

pub struct StepTransaction {
    pub signer: StepSigner,
    pub instructions: Vec<RegistryInstruction>,
}

/// Who signs a transaction of a step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepSigner {
    /// The key that runs `apply`. It writes buffers and creates organizations, which need no
    /// authority.
    Writer,
    /// The organization authority, which also pays. With `--squads` it is a vault.
    Authority,
}

/// The definitions, the accounts that the registry holds for them, and the keys that sign. Without
/// `--squads`, the writer and the authority are the same key.
pub struct Sync<'s> {
    pub catalog: &'s Catalog,
    pub organizations: &'s [OrganizationSettings],
    pub indexes: &'s [IndexSettings],
    pub accounts: &'s HashMap<Address, Account>,
    pub writer: Address,
    pub authority: Address,
}

/// A document's place in the registry.
struct Place {
    organization: Address,
    index: Address,
    version: Address,
}

/// What a document publishes, and where.
struct Document<'d> {
    id: &'d Id,
    version: &'d SemverV1,
    bytes: &'d [u8],
    at: Place,
    interface_index: Option<Address>,
}

impl Sync<'_> {
    /// Every account that the steps read: each organization, index, and version account.
    pub fn addresses(catalog: &Catalog) -> Result<Vec<Address>, String> {
        let interfaces = sorted_interfaces(catalog)
            .into_iter()
            .map(|interface| place(DocumentKind::Interface, &interface.id, &interface.version));
        let implementations = sorted_implementations(catalog)
            .into_iter()
            .map(|implementation| place(DocumentKind::Implementation, &implementation.id, &implementation.version));
        let places = interfaces.chain(implementations).collect::<Result<Vec<_>, _>>()?;

        Ok(places.iter().flat_map(|at| [at.organization, at.index, at.version]).fold(
            Vec::new(),
            |mut unique, address| {
                if !unique.contains(&address) {
                    unique.push(address);
                }

                unique
            },
        ))
    }

    pub fn steps(&self) -> Result<Vec<Step>, String> {
        let interfaces = sorted_interfaces(self.catalog);
        let implementations = sorted_implementations(self.catalog);
        let names = organization_names(&interfaces, &implementations);

        let created = names.iter().filter_map(|name| self.create_organization(name)).collect::<Result<Vec<_>, _>>()?;
        let interface_steps = all(interfaces.iter().map(|interface| self.interface_steps(interface)))?;
        let policies = all(interfaces.iter().map(|interface| self.policy_step(&interface.id)))?;
        let indexes = all(implementations.iter().map(|implementation| self.implementation_index_step(implementation)))?;
        let approvals = all(interfaces.iter().map(|interface| self.approval_steps(&interface.id)))?;
        let versions =
            all(implementations.iter().map(|implementation| self.implementation_version_step(implementation)))?;
        let version_approvals = all(interfaces.iter().map(|interface| self.version_approval_steps(&interface.id)))?;
        let interface_tails = all(interfaces.iter().map(|interface| self.index_tail(Kind::Interface, &interface.id)))?;
        let implementation_tails = all(implementations
            .iter()
            .map(|implementation| self.index_tail(Kind::Implementation, &implementation.id)))?;
        let moved =
            names.iter().filter_map(|name| self.move_organization_authority(name)).collect::<Result<Vec<_>, _>>()?;

        let groups = [
            created,
            interface_steps,
            policies,
            indexes,
            approvals,
            versions,
            version_approvals,
            interface_tails,
            implementation_tails,
            moved,
        ];

        let steps: Vec<Step> = groups.into_iter().flatten().collect();

        if !steps.is_empty() {
            names.iter().try_for_each(|name| self.check_signer(name))?;
        }

        Ok(steps)
    }

    /// Each step signs as the organization authority, so an organization that the registry holds
    /// must have that authority.
    fn check_signer(&self, name: &str) -> Result<(), String> {
        let Some(account) = self.accounts.get(&publisher(name)) else { return Ok(()) };
        let organization = OrganizationView::parse(&account.data).map_err(|error| format!("{name}: {error}"))?;

        match *organization.authority() == self.authority {
            true => Ok(()),
            false => Err(format!(
                "the authority of {name} is {}, not {}",
                base58(organization.authority()),
                base58(&self.authority)
            )),
        }
    }

    /// An organization that the registry does not hold is created with the authority. The writer
    /// creates it, because creation needs no signature of the authority.
    fn create_organization(&self, name: &str) -> Option<Result<Step, String>> {
        let Some(account) = self.accounts.get(&publisher(name)) else {
            let created = registry::create_organization(&self.writer, name, &self.authority).map(|instruction| Step {
                description: format!("create the organization {name}"),
                transactions: vec![StepTransaction { signer: StepSigner::Writer, instructions: vec![instruction] }],
            });

            return Some(created.map_err(|error| error.to_string()));
        };

        OrganizationView::parse(&account.data).err().map(|error| Err(format!("{name}: {error}")))
    }

    fn move_organization_authority(&self, name: &str) -> Option<Result<Step, String>> {
        let wanted = self.organizations.iter().find(|settings| settings.organization == name)?.authority?;
        let current = match self.accounts.get(&publisher(name)) {
            None => self.authority,
            Some(account) => match OrganizationView::parse(&account.data) {
                Ok(view) => *view.authority(),
                Err(error) => return Some(Err(format!("{name}: {error}"))),
            },
        };

        (current != wanted).then(|| {
            let instruction = registry::set_organization_authority(&publisher(name), &current, &wanted);

            Ok(step(format!("move the authority of {name} to {}", base58(&wanted)), vec![instruction]))
        })
    }

    fn interface_steps(&self, interface: &CompiledInterface) -> Result<Vec<Step>, String> {
        let at = place(DocumentKind::Interface, &interface.id, &interface.version)?;
        let index = (!self.exists(&at.index)).then(|| {
            let new = NewInterface {
                payer: &self.authority,
                authority: &self.authority,
                organization: &at.organization,
                index: &at.index,
            };
            let instruction = registry::create_interface(&new, &interface.id.name_hash(), IndexAuthorities::default());

            step(format!("create the interface index {}", interface.id), vec![instruction])
        });
        let document = Document {
            id: &interface.id,
            version: &interface.version,
            bytes: &interface.bytes,
            at,
            interface_index: None,
        };

        Ok(index.into_iter().chain(self.publish_step(&document)?).collect())
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
        let instruction = registry::create_implementation(&new, &implementation.id.name_hash(), &Address::default());

        Ok(Some(step(format!("create the implementation index {}", implementation.id), vec![instruction])))
    }

    fn implementation_version_step(&self, implementation: &CompiledImplementation) -> Result<Option<Step>, String> {
        let document = Document {
            id: &implementation.id,
            version: &implementation.version,
            bytes: &implementation.bytes,
            at: place(DocumentKind::Implementation, &implementation.id, &implementation.version)?,
            interface_index: Some(implemented_index(implementation)?),
        };

        self.publish_step(&document)
    }

    /// Writes the document to a buffer in parts, then publishes it. A version that the registry
    /// holds must hold the same document, because a version never changes.
    fn publish_step(&self, document: &Document<'_>) -> Result<Option<Step>, String> {
        let label = format!("{}@{}", document.id, version_text(document.version));
        let at = &document.at;

        if let Some(account) = self.accounts.get(&at.version) {
            return match account.data.get(VERSION_DOCUMENT_OFFSET..) == Some(document.bytes) {
                true => Ok(None),
                false => Err(format!("the registry holds another document at {label}. Publish a new version.")),
            };
        }

        let bytes = document.bytes;
        let document_hash: [u8; 32] = Sha256::digest(bytes).into();
        let buffer_id = document_hash.first_chunk::<4>().map_or(0, |prefix| u32::from_le_bytes(*prefix));
        let buffer = registry::buffer_address(&self.writer, buffer_id).map_err(|error| error.to_string())?;
        let writes = bytes
            .chunks(BUFFER_PART)
            .zip((0..).step_by(BUFFER_PART))
            .map(|(part, offset)| {
                registry::write_buffer(&self.writer, &buffer, buffer_id, bytes.len(), offset, part)
                    .map(|instruction| StepTransaction { signer: StepSigner::Writer, instructions: vec![instruction] })
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let publication = Publication {
            payer: self.authority,
            authority: self.authority,
            organization: at.organization,
            index: at.index,
            buffer,
            buffer_writer: self.writer,
            version: at.version,
            interface_index: document.interface_index,
        };

        let publish = StepTransaction {
            signer: StepSigner::Authority,
            instructions: vec![publication.instruction(&document_hash)],
        };
        let transactions = writes.into_iter().chain([publish]).collect();

        Ok(Some(Step { description: format!("publish {label}"), transactions }))
    }

    fn policy_step(&self, interface: &Id) -> Result<Option<Step>, String> {
        let wanted =
            self.index_settings(Kind::Interface, interface).is_some_and(|settings| settings.approve_new_versions);
        let index = index_of(DocumentKind::Interface, interface)?;
        let current = self.index(&index)?.is_some_and(|view| view.approve_new_versions());

        if current == wanted {
            return Ok(None);
        }

        let instruction = self.change(interface, index).set_approval_policy(wanted);

        Ok(Some(step(format!("set approveNewVersions of {interface} to {wanted}"), vec![instruction])))
    }

    fn approval_steps(&self, interface: &Id) -> Result<Vec<Step>, String> {
        let Some(settings) = self.index_settings(Kind::Interface, interface) else { return Ok(Vec::new()) };
        let interface_index = index_of(DocumentKind::Interface, interface)?;

        settings
            .approvals
            .iter()
            .map(|implementation| {
                let approval = self.approval(interface, &interface_index, &implementation.id)?;
                let approved =
                    self.index(&interface_index)?.is_some_and(|view| view.approves(&approval.implementation_index));
                let description = format!("approve {} for {interface}", implementation.id);

                Ok((!approved).then(|| step(description, vec![approval.approve_implementation(&self.authority)])))
            })
            .filter_map(Result::transpose)
            .collect()
    }

    /// A version that is new and that the interface approves at publish needs no approval.
    fn version_approval_steps(&self, interface: &Id) -> Result<Vec<Step>, String> {
        let Some(settings) = self.index_settings(Kind::Interface, interface) else { return Ok(Vec::new()) };
        let interface_index = index_of(DocumentKind::Interface, interface)?;
        let mut steps = Vec::new();

        for implementation in &settings.approvals {
            let approval = self.approval(interface, &interface_index, &implementation.id)?;

            for version in &implementation.versions {
                let entry = self.index(&approval.implementation_index)?.and_then(|view| view.entry(version));
                let approved_at_publish = entry.is_none() && settings.approve_new_versions;

                if entry.is_some_and(|entry| entry.approved) || approved_at_publish {
                    continue;
                }

                let description = format!("approve {}@{}", implementation.id, version_text(version));
                steps.push(step(description, vec![approval.approve_version(version)]));
            }
        }

        Ok(steps)
    }

    /// The head, then the authorities, that the index file states.
    fn index_tail(&self, kind: Kind, id: &Id) -> Result<Vec<Step>, String> {
        let Some(settings) = self.index_settings(kind, id) else { return Ok(Vec::new()) };
        let index = index_of(document_kind(kind), id)?;
        let view = self.index(&index)?;
        let change = self.change(id, index);

        let current_head = view.as_ref().and_then(IndexView::head);
        let head = settings
            .head
            .filter(|head| current_head != Some(*head))
            .map(|head| step(format!("set the head of {id} to {}", version_text(&head)), vec![change.set_head(&head)]));

        let update = view.as_ref().map_or(Address::default(), |view| *view.update_authority());
        let update_step = (update != settings.update_authority).then(|| {
            let description = format!("move the update authority of {id} to {}", base58(&settings.update_authority));

            step(description, vec![change.set_update_authority(&settings.update_authority)])
        });

        let approve = view.as_ref().map_or(Address::default(), |view| *view.approve_authority());
        let approve_step = (kind == Kind::Interface && approve != settings.approve_authority).then(|| {
            let description = format!("move the approve authority of {id} to {}", base58(&settings.approve_authority));

            step(description, vec![change.set_approve_authority(&settings.approve_authority)])
        });

        Ok(head.into_iter().chain(update_step).chain(approve_step).collect())
    }

    fn approval(&self, interface: &Id, interface_index: &Address, implementation: &Id) -> Result<Approval, String> {
        Ok(Approval {
            authority: self.authority,
            organization: publisher(&interface.organization),
            interface_index: *interface_index,
            implementation_index: index_of(DocumentKind::Implementation, implementation)?,
        })
    }

    fn change(&self, id: &Id, index: Address) -> IndexChange {
        IndexChange { authority: self.authority, organization: publisher(&id.organization), index }
    }

    fn index_settings(&self, kind: Kind, id: &Id) -> Option<&IndexSettings> {
        self.indexes.iter().find(|settings| settings.kind == kind && settings.id == *id)
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

/// The steps of each item, in order, or the first failure.
fn all<S: IntoIterator<Item = Step>>(results: impl Iterator<Item = Result<S, String>>) -> Result<Vec<Step>, String> {
    results.collect::<Result<Vec<_>, _>>().map(|steps| steps.into_iter().flatten().collect())
}

/// A step of one transaction, which the authority signs.
fn step(description: String, instructions: Vec<RegistryInstruction>) -> Step {
    Step { description, transactions: vec![StepTransaction { signer: StepSigner::Authority, instructions }] }
}

fn organization_names(interfaces: &[&CompiledInterface], implementations: &[&CompiledImplementation]) -> Vec<String> {
    let mut names: Vec<String> = interfaces
        .iter()
        .map(|interface| interface.id.organization.clone())
        .chain(implementations.iter().map(|implementation| implementation.id.organization.clone()))
        .collect();
    names.sort_unstable();
    names.dedup();

    names
}

fn document_kind(kind: Kind) -> DocumentKind {
    match kind {
        Kind::Interface => DocumentKind::Interface,
        Kind::Implementation => DocumentKind::Implementation,
    }
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
    interfaces.sort_by_key(|interface| interface.id.to_string());

    interfaces
}

fn sorted_implementations(catalog: &Catalog) -> Vec<&CompiledImplementation> {
    let mut implementations: Vec<_> = catalog.implementations().collect();
    implementations.sort_by_key(|implementation| implementation.id.to_string());

    implementations
}

fn base58(address: &Address) -> String {
    bs58::encode(address.0).into_string()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::lint::compile_tree;
    use crate::settings::{read_settings, TreeSettings};
    use crate::tree::Tree;

    const SIGNER: Address = Address([1; 32]);
    const VAULT: Address = Address([2; 32]);

    fn definitions() -> Tree {
        Tree::read(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../definitions")).unwrap()
    }

    fn descriptions(tree: &Tree, settings: &TreeSettings) -> Vec<String> {
        let compiled = compile_tree(tree);
        let accounts = HashMap::new();
        let sync = Sync {
            catalog: &compiled.catalog,
            organizations: &settings.organizations,
            indexes: &settings.indexes,
            accounts: &accounts,
            writer: SIGNER,
            authority: SIGNER,
        };

        sync.steps().unwrap().into_iter().map(|step| step.description).collect()
    }

    /// An empty registry needs the organization first, then each interface, then each
    /// implementation's index and approval before its version, and the version approvals last.
    #[test]
    fn plans_an_empty_registry_in_the_order_that_it_accepts() {
        let tree = definitions();
        let steps = descriptions(&tree, &read_settings(&tree).unwrap());
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
        assert_eq!(steps.last().map(String::as_str), Some("set the head of solana.org/token-2022-transfer to 1.0.0"));
        assert_eq!(steps.len(), 45);
    }

    /// Every step before the moves needs the signer to be the authority.
    #[test]
    fn moves_each_authority_last() {
        let tree = definitions();
        let mut settings = read_settings(&tree).unwrap();
        settings.organizations.push(OrganizationSettings { organization: "solana.org".into(), authority: Some(VAULT) });
        settings.indexes.iter_mut().for_each(|index| index.head = None);

        let token_transfer = settings.indexes.iter_mut().find(|index| index.id.name == "token.transfer").unwrap();
        token_transfer.approve_authority = VAULT;
        let steps = descriptions(&tree, &settings);
        let vault = bs58::encode(VAULT.0).into_string();

        assert_eq!(steps.len(), 37);
        assert_eq!(steps[35], format!("move the approve authority of solana.org/token.transfer to {vault}"));
        assert_eq!(steps[36], format!("move the authority of solana.org to {vault}"));
    }
}
