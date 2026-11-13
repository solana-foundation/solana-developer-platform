//! The registry's instructions in Anchor v2's layout: the first 8 bytes of the SHA-256 of
//! `global:<instruction>`, then each argument in borsh, with each account at the place and in the role
//! that the registry's account struct gives it.

use sha2::{Digest as _, Sha256};

use sdp_intents_spec::wire::SemverV1;
use sdp_intents_spec::{AccountRole, Address};

use crate::{organization_address, Meta, RegistryError, RegistryInstruction, REGISTRY_PROGRAM};

const SYSTEM_PROGRAM: Address = Address([0; 32]);
/// A registry buffer holds a document of at most 10,000 bytes.
const MAX_DOCUMENT_LEN: usize = 10_000;

/// Creates the organization `name` with `authority`.
pub fn create_organization(
    payer: &Address,
    name: &str,
    authority: &Address,
) -> Result<RegistryInstruction, RegistryError> {
    let accounts = vec![writable_signer(payer), writable(&organization_address(name)?), readonly(&SYSTEM_PROGRAM)];

    Ok(instruction(
        "create_organization",
        &[&crate::name_hash(name), &borsh_bytes(name.as_bytes())?, &authority.0],
        accounts,
    ))
}

/// Moves the organization's authority to `new_authority`. Its current authority signs.
pub fn set_organization_authority(
    organization: &Address,
    authority: &Address,
    new_authority: &Address,
) -> RegistryInstruction {
    instruction("set_organization_authority", &[&new_authority.0], vec![writable(organization), signer(authority)])
}

/// The authorities of a new index. `Address::default()` follows the organization authority.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IndexAuthorities {
    pub update: Address,
    pub approve: Address,
}

/// The accounts that the index of an interface is created with.
pub struct NewInterface<'n> {
    pub payer: &'n Address,
    pub authority: &'n Address,
    pub organization: &'n Address,
    pub index: &'n Address,
}

/// Creates the index of an interface.
pub fn create_interface(
    new: &NewInterface<'_>,
    name_hash: &[u8; 32],
    authorities: IndexAuthorities,
) -> RegistryInstruction {
    let accounts = vec![
        writable_signer(new.payer),
        readonly(new.organization),
        signer(new.authority),
        writable(new.index),
        readonly(&SYSTEM_PROGRAM),
    ];

    instruction("create_interface", &[name_hash, &authorities.update.0, &authorities.approve.0], accounts)
}

/// The accounts that the index of an implementation is created with.
pub struct NewImplementation<'n> {
    pub payer: &'n Address,
    pub authority: &'n Address,
    pub organization: &'n Address,
    pub interface_index: &'n Address,
    pub index: &'n Address,
}

/// Creates the index of an implementation of the interface at `interface_index`, with
/// `update_authority`. `Address::default()` follows the organization authority.
pub fn create_implementation(
    new: &NewImplementation<'_>,
    name_hash: &[u8; 32],
    update_authority: &Address,
) -> RegistryInstruction {
    let accounts = vec![
        writable_signer(new.payer),
        readonly(new.organization),
        signer(new.authority),
        readonly(new.interface_index),
        writable(new.index),
        readonly(&SYSTEM_PROGRAM),
    ];

    instruction("create_implementation", &[name_hash, &update_authority.0], accounts)
}

/// Writes `bytes` at `offset` of the buffer `buffer_id` of `writer`, which holds a document of
/// `document_len` bytes.
pub fn write_buffer(
    writer: &Address,
    buffer: &Address,
    buffer_id: u32,
    document_len: usize,
    offset: usize,
    bytes: &[u8],
) -> Result<RegistryInstruction, RegistryError> {
    if document_len > MAX_DOCUMENT_LEN {
        return Err(RegistryError::DocumentTooLarge);
    }

    let to_u16 = |value: usize| u16::try_from(value).map_err(|_| RegistryError::DocumentTooLarge);
    let accounts = vec![writable_signer(writer), writable(buffer), readonly(&SYSTEM_PROGRAM)];
    let args: [&[u8]; 4] = [
        &buffer_id.to_le_bytes(),
        &to_u16(document_len)?.to_le_bytes(),
        &to_u16(offset)?.to_le_bytes(),
        &borsh_bytes(bytes)?,
    ];

    Ok(instruction("write_buffer", &args, accounts))
}

/// The signer, the organization that resolves its authority, and the index that changes.
pub struct IndexChange {
    pub authority: Address,
    pub organization: Address,
    pub index: Address,
}

impl IndexChange {
    pub fn set_approval_policy(&self, approve_new_versions: bool) -> RegistryInstruction {
        instruction("set_approval_policy", &[&[u8::from(approve_new_versions)]], self.accounts())
    }

    pub fn set_update_authority(&self, new_authority: &Address) -> RegistryInstruction {
        instruction("set_update_authority", &[&new_authority.0], self.accounts())
    }

    pub fn set_approve_authority(&self, new_authority: &Address) -> RegistryInstruction {
        instruction("set_approve_authority", &[&new_authority.0], self.accounts())
    }

    pub fn set_head(&self, version: &SemverV1) -> RegistryInstruction {
        instruction("set_head", &[&version.major.0, &version.minor.0, &version.patch.0], self.accounts())
    }

    fn accounts(&self) -> Vec<Meta> {
        vec![signer(&self.authority), readonly(&self.organization), writable(&self.index)]
    }
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

impl Publication {
    /// `publish` creates the version account from the buffer, which must hash to `document_hash`.
    /// Anchor names an absent optional account by the program's own address.
    pub fn instruction(&self, document_hash: &[u8; 32]) -> RegistryInstruction {
        let accounts = vec![
            writable_signer(&self.payer),
            signer(&self.authority),
            readonly(&self.organization),
            writable(&self.index),
            writable(&self.buffer),
            writable(&self.buffer_writer),
            writable(&self.version),
            readonly(&self.interface_index.unwrap_or(REGISTRY_PROGRAM)),
            readonly(&SYSTEM_PROGRAM),
        ];

        instruction("publish", &[document_hash], accounts)
    }
}

/// An approval by the interface's approve authority. `organization` is the interface's.
pub struct Approval {
    pub authority: Address,
    pub organization: Address,
    pub interface_index: Address,
    pub implementation_index: Address,
}

impl Approval {
    /// Adds the implementation to the interface's list of approved implementations.
    pub fn approve_implementation(&self, payer: &Address) -> RegistryInstruction {
        let accounts = vec![
            writable_signer(payer),
            signer(&self.authority),
            readonly(&self.organization),
            writable(&self.interface_index),
            readonly(&self.implementation_index),
            readonly(&SYSTEM_PROGRAM),
        ];

        instruction("approve_implementation", &[], accounts)
    }

    pub fn approve_version(&self, version: &SemverV1) -> RegistryInstruction {
        let accounts = vec![
            signer(&self.authority),
            readonly(&self.organization),
            readonly(&self.interface_index),
            writable(&self.implementation_index),
        ];

        instruction("approve_version", &[&version.major.0, &version.minor.0, &version.patch.0], accounts)
    }
}

fn instruction(name: &str, args: &[&[u8]], accounts: Vec<Meta>) -> RegistryInstruction {
    let digest: [u8; 32] = Sha256::digest(format!("global:{name}").as_bytes()).into();
    let discriminator = digest.get(..8).unwrap_or_default();

    RegistryInstruction { accounts, data: [&[discriminator][..], args].concat().concat() }
}

/// A borsh `Vec<u8>`: a `u32` length, then the bytes.
fn borsh_bytes(bytes: &[u8]) -> Result<Vec<u8>, RegistryError> {
    let len = u32::try_from(bytes.len()).map_err(|_| RegistryError::DocumentTooLarge)?;

    Ok([&len.to_le_bytes()[..], bytes].concat())
}

fn meta(address: &Address, role: AccountRole) -> Meta {
    Meta { address: *address, role }
}

fn readonly(address: &Address) -> Meta {
    meta(address, AccountRole::Readonly)
}

fn writable(address: &Address) -> Meta {
    meta(address, AccountRole::Writable)
}

fn signer(address: &Address) -> Meta {
    meta(address, AccountRole::ReadonlySigner)
}

fn writable_signer(address: &Address) -> Meta {
    meta(address, AccountRole::WritableSigner)
}
