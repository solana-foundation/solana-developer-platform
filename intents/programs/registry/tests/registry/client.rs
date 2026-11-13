//! The instructions of the registry, as a client builds them, and the addresses of its accounts.

use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{Address, Id, InstructionData, ToAccountMetas};
use registry::{accounts, instruction};
use sdp_intents_spec::wire::{DocumentKind, SemverV1};

pub fn system_program() -> Address {
    anchor_lang::programs::System::id()
}

pub fn name_hash(name: &str) -> [u8; 32] {
    anchor_lang::sha256(name.as_bytes())
}

pub fn organization_address(name: &str) -> Address {
    Address::find_program_address(&[b"org", &name_hash(name)], &registry::ID).0
}

pub fn index_address(kind: DocumentKind, organization: &Address, name: &str) -> Address {
    Address::find_program_address(&[b"index", &[kind.into()], organization.as_ref(), &name_hash(name)], &registry::ID).0
}

pub fn version_address(kind: DocumentKind, organization: &Address, name: &str, version: &SemverV1) -> Address {
    let seed: &[u8] = if kind == DocumentKind::Interface { b"interface" } else { b"implementation" };
    let seeds: [&[u8]; 6] =
        [seed, organization.as_ref(), &name_hash(name), &version.major.0, &version.minor.0, &version.patch.0];

    Address::find_program_address(&seeds, &registry::ID).0
}

pub fn buffer_address(writer: &Address, buffer_id: u32) -> Address {
    Address::find_program_address(&[b"buffer", writer.as_ref(), &buffer_id.to_le_bytes()], &registry::ID).0
}

fn registry_instruction(data: Vec<u8>, accounts: impl ToAccountMetas) -> Instruction {
    Instruction::new_with_bytes(registry::ID, &data, accounts.to_account_metas(None))
}

pub fn create_organization(payer: &Address, name: &str, authority: &Address) -> Instruction {
    let organization = organization_address(name);
    let data =
        instruction::CreateOrganization { name_hash: name_hash(name), name: name.as_bytes(), authority: *authority };

    registry_instruction(
        data.data(),
        accounts::CreateOrganization { payer: *payer, organization, system_program: system_program() },
    )
}

pub fn set_organization_authority(organization: &Address, authority: &Address, new_authority: &Address) -> Instruction {
    registry_instruction(
        instruction::SetOrganizationAuthority { new_authority: *new_authority }.data(),
        accounts::SetOrganizationAuthority { organization: *organization, authority: *authority },
    )
}

/// The update authority and the approve authority are `Address::default()`, so they follow the
/// organization authority.
pub fn create_interface(payer: &Address, authority: &Address, organization: &Address, name: &str) -> Instruction {
    let data = instruction::CreateInterface {
        name_hash: name_hash(name),
        update_authority: Address::default(),
        approve_authority: Address::default(),
    };
    let accounts = accounts::CreateInterface {
        payer: *payer,
        organization: *organization,
        authority: *authority,
        index: index_address(DocumentKind::Interface, organization, name),
        system_program: system_program(),
    };

    registry_instruction(data.data(), accounts)
}

pub fn create_implementation(
    payer: &Address,
    authority: &Address,
    organization: &Address,
    interface_index: &Address,
    name: &str,
) -> Instruction {
    let data = instruction::CreateImplementation { name_hash: name_hash(name), update_authority: Address::default() };
    let accounts = accounts::CreateImplementation {
        payer: *payer,
        organization: *organization,
        authority: *authority,
        interface_index: *interface_index,
        index: index_address(DocumentKind::Implementation, organization, name),
        system_program: system_program(),
    };

    registry_instruction(data.data(), accounts)
}

/// The signer, the organization that resolves its authority, and the index that changes.
pub struct IndexChange {
    pub authority: Address,
    pub organization: Address,
    pub index: Address,
}

impl IndexChange {
    fn accounts(&self) -> accounts::ChangeIndex {
        accounts::ChangeIndex { authority: self.authority, organization: self.organization, index: self.index }
    }

    pub fn set_update_authority(&self, new_authority: &Address) -> Instruction {
        registry_instruction(instruction::SetUpdateAuthority { new_authority: *new_authority }.data(), self.accounts())
    }

    pub fn set_approve_authority(&self, new_authority: &Address) -> Instruction {
        registry_instruction(instruction::SetApproveAuthority { new_authority: *new_authority }.data(), self.accounts())
    }

    pub fn set_approval_policy(&self, approve_new_versions: bool) -> Instruction {
        registry_instruction(instruction::SetApprovalPolicy { approve_new_versions }.data(), self.accounts())
    }

    pub fn set_head(&self, version: &SemverV1) -> Instruction {
        let data =
            instruction::SetHead { major: version.major.get(), minor: version.minor.get(), patch: version.patch.get() };

        registry_instruction(data.data(), self.accounts())
    }
}

pub fn write_buffer(writer: &Address, buffer_id: u32, document_len: u16, offset: u16, bytes: &[u8]) -> Instruction {
    let data = instruction::WriteBuffer { buffer_id, document_len, offset, bytes };
    let accounts = accounts::WriteBuffer {
        writer: *writer,
        buffer: buffer_address(writer, buffer_id),
        system_program: system_program(),
    };

    registry_instruction(data.data(), accounts)
}

pub fn close_buffer(writer: &Address, buffer: &Address) -> Instruction {
    registry_instruction(instruction::CloseBuffer {}.data(), accounts::CloseBuffer { writer: *writer, buffer: *buffer })
}

/// The accounts of `publish`. `interface_index` is set when `index` is an implementation's.
pub struct Publication {
    pub payer: Address,
    pub authority: Address,
    pub organization: Address,
    pub index: Address,
    pub buffer: Address,
    pub buffer_writer: Address,
    pub version: Address,
    pub interface_index: Option<Address>,
}

pub fn publish(publication: &Publication, document_hash: [u8; 32]) -> Instruction {
    let accounts = accounts::Publish {
        payer: publication.payer,
        authority: publication.authority,
        organization: publication.organization,
        index: publication.index,
        buffer: publication.buffer,
        buffer_writer: publication.buffer_writer,
        version: publication.version,
        interface_index: publication.interface_index,
        system_program: system_program(),
    };

    registry_instruction(instruction::Publish { document_hash }.data(), accounts)
}

/// The accounts of `remove`: the version account goes, and its rent goes to `recipient`.
pub struct Removal {
    pub authority: Address,
    pub organization: Address,
    pub index: Address,
    pub version: Address,
    pub recipient: Address,
}

pub fn remove(removal: &Removal, version: &SemverV1) -> Instruction {
    let data =
        instruction::Remove { major: version.major.get(), minor: version.minor.get(), patch: version.patch.get() };
    let accounts = accounts::Remove {
        authority: removal.authority,
        organization: removal.organization,
        index: removal.index,
        version: removal.version,
        recipient: removal.recipient,
    };

    registry_instruction(data.data(), accounts)
}

/// An approval by the interface's approve authority. `organization` is the interface's.
pub struct Approval {
    pub authority: Address,
    pub organization: Address,
    pub interface_index: Address,
    pub implementation_index: Address,
}

impl Approval {
    pub fn approve_implementation(&self, payer: &Address) -> Instruction {
        let accounts = accounts::ApproveImplementation {
            payer: *payer,
            authority: self.authority,
            organization: self.organization,
            interface_index: self.interface_index,
            implementation_index: self.implementation_index,
            system_program: system_program(),
        };

        registry_instruction(instruction::ApproveImplementation {}.data(), accounts)
    }

    pub fn unapprove_implementation(&self, recipient: &Address) -> Instruction {
        let accounts = accounts::UnapproveImplementation {
            authority: self.authority,
            organization: self.organization,
            interface_index: self.interface_index,
            implementation_index: self.implementation_index,
            recipient: *recipient,
        };

        registry_instruction(instruction::UnapproveImplementation {}.data(), accounts)
    }

    pub fn set_version_approval(&self, approved: bool, version: &SemverV1) -> Instruction {
        let accounts = accounts::SetVersionApproval {
            authority: self.authority,
            organization: self.organization,
            interface_index: self.interface_index,
            implementation_index: self.implementation_index,
        };
        let (major, minor, patch) = (version.major.get(), version.minor.get(), version.patch.get());
        let data = if approved {
            instruction::ApproveVersion { major, minor, patch }.data()
        } else {
            instruction::UnapproveVersion { major, minor, patch }.data()
        };

        registry_instruction(data, accounts)
    }
}
