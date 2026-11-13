//! An organization in the registry, and the steps that publish its documents.

use anchor_lang::Address;
use anchor_v2_testing::litesvm::LiteSVM;
use anchor_v2_testing::{Keypair, Signer};
use sdp_intents_spec::wire::{DocumentKind, SemverV1};
use sdp_intents_spec::{Implementation, Interface};

use crate::client::{self, Approval, Publication};
use crate::svm::{failure, funded, send, Failure, SOL};

/// A transaction holds at most 1,232 bytes, so a buffer takes a document in parts.
const BUFFER_PART: usize = 800;

pub struct Organization {
    pub name: String,
    pub address: Address,
    pub authority: Keypair,
}

impl Organization {
    pub fn create(svm: &mut LiteSVM, name: &str) -> Result<Self, Failure> {
        let authority = funded(svm, 10 * SOL)?;
        let create = client::create_organization(&authority.pubkey(), name, &authority.pubkey());
        send(svm, &[create], &[&authority])?;

        Ok(Self { name: name.to_owned(), address: client::organization_address(name), authority })
    }

    pub fn index(&self, kind: DocumentKind, name: &str) -> Address {
        client::index_address(kind, &self.address, name)
    }

    pub fn create_interface(&self, svm: &mut LiteSVM, name: &str) -> Result<Address, Failure> {
        let authority = self.authority.pubkey();
        send(svm, &[client::create_interface(&authority, &authority, &self.address, name)], &[&self.authority])?;

        Ok(self.index(DocumentKind::Interface, name))
    }

    pub fn create_implementation(
        &self,
        svm: &mut LiteSVM,
        name: &str,
        interface_index: &Address,
    ) -> Result<Address, Failure> {
        let authority = self.authority.pubkey();
        let create = client::create_implementation(&authority, &authority, &self.address, interface_index, name);
        send(svm, &[create], &[&self.authority])?;

        Ok(self.index(DocumentKind::Implementation, name))
    }

    /// Writes `document` to a buffer of the organization authority, then publishes it with that key.
    pub fn publish(
        &self,
        svm: &mut LiteSVM,
        name: &str,
        document: &[u8],
        interface_index: Option<Address>,
    ) -> Result<Address, Failure> {
        self.publish_as(svm, &self.authority, name, document, interface_index)
    }

    pub fn publish_as(
        &self,
        svm: &mut LiteSVM,
        authority: &Keypair,
        name: &str,
        document: &[u8],
        interface_index: Option<Address>,
    ) -> Result<Address, Failure> {
        let target = DocumentTarget::of(document)?;
        let buffer = write_buffer(svm, authority, document)?;
        let publication = Publication {
            payer: authority.pubkey(),
            authority: authority.pubkey(),
            organization: self.address,
            index: self.index(target.kind, name),
            buffer,
            buffer_writer: authority.pubkey(),
            version: client::version_address(target.kind, &self.address, name, &target.version),
            interface_index,
        };
        send(svm, &[client::publish(&publication, anchor_lang::sha256(document))], &[authority])?;

        Ok(publication.version)
    }

    /// Adds the implementation to the interface's list, and approves one of its versions.
    pub fn approve(&self, svm: &mut LiteSVM, approval: &Approval, version: &SemverV1) -> Result<(), Failure> {
        let instructions =
            [approval.approve_implementation(&self.authority.pubkey()), approval.set_version_approval(true, version)];

        send(svm, &instructions, &[&self.authority]).map(|_| ())
    }

    pub fn approval(&self, interface_index: &Address, implementation_index: &Address) -> Approval {
        Approval {
            authority: self.authority.pubkey(),
            organization: self.address,
            interface_index: *interface_index,
            implementation_index: *implementation_index,
        }
    }
}

/// The kind and the version that a document states.
pub struct DocumentTarget {
    pub kind: DocumentKind,
    pub version: SemverV1,
}

impl DocumentTarget {
    pub fn of(document: &[u8]) -> Result<Self, Failure> {
        if let Ok(interface) = Interface::parse(document) {
            return Ok(Self { kind: DocumentKind::Interface, version: interface.id().version });
        }

        let implementation = Implementation::parse(document).map_err(|error| failure(error.to_string()))?;

        Ok(Self { kind: DocumentKind::Implementation, version: implementation.id().version })
    }
}

/// Writes `document` in parts to a new buffer of `writer`, and returns the buffer's address.
pub fn write_buffer(svm: &mut LiteSVM, writer: &Keypair, document: &[u8]) -> Result<Address, Failure> {
    let buffer_id =
        anchor_lang::sha256(document).first_chunk::<4>().map(|bytes| u32::from_le_bytes(*bytes)).unwrap_or_default();
    let document_len = u16::try_from(document.len()).map_err(|_| failure("the document is too long".into()))?;

    for (part, offset) in document.chunks(BUFFER_PART).zip((0..).step_by(BUFFER_PART)) {
        let offset = u16::try_from(offset).map_err(|_| failure("the offset is too large".into()))?;
        send(svm, &[client::write_buffer(&writer.pubkey(), buffer_id, document_len, offset, part)], &[writer])?;
    }

    Ok(client::buffer_address(&writer.pubkey(), buffer_id))
}
