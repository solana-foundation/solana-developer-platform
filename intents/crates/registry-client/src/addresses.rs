//! The program addresses of the registry's accounts, from the seeds that the registry derives
//! them with.

use sha2::{Digest as _, Sha256};

use sdp_intents_spec::wire::{DocumentKind, SemverV1};
use sdp_intents_spec::Address;

use crate::{RegistryError, REGISTRY_PROGRAM};

/// The SHA-256 of a name, which every seed and document id uses in place of the name.
pub fn name_hash(name: &str) -> [u8; 32] {
    Sha256::digest(name.as_bytes()).into()
}

pub fn organization_address(name: &str) -> Result<Address, RegistryError> {
    find(&[b"org", &name_hash(name)])
}

pub fn index_address(
    kind: DocumentKind,
    organization: &Address,
    name_hash: &[u8; 32],
) -> Result<Address, RegistryError> {
    find(&[b"index", &[kind.into()], &organization.0, name_hash])
}

pub fn version_address(
    kind: DocumentKind,
    organization: &Address,
    name_hash: &[u8; 32],
    version: &SemverV1,
) -> Result<Address, RegistryError> {
    let seed: &[u8] = if kind == DocumentKind::Interface { b"interface" } else { b"implementation" };

    find(&[seed, &organization.0, name_hash, &version.major.0, &version.minor.0, &version.patch.0])
}

pub fn buffer_address(writer: &Address, buffer_id: u32) -> Result<Address, RegistryError> {
    find(&[b"buffer", &writer.0, &buffer_id.to_le_bytes()])
}

fn find(seeds: &[&[u8]]) -> Result<Address, RegistryError> {
    let program = solana_address::Address::new_from_array(REGISTRY_PROGRAM.0);
    let (address, _bump) =
        solana_address::Address::try_find_program_address(seeds, &program).ok_or(RegistryError::NoAddress)?;

    Ok(Address(address.to_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_constant_is_the_registry() {
        assert_eq!(bs58::encode(REGISTRY_PROGRAM.0).into_string(), "9sgttDZ2vnzb85HWuQbx8vy6Boga32zpP5QRZ7UtbWpp");
    }
}
