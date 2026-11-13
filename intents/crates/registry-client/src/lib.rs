//! The registry program as a client sees it: the address of each account, the instructions in the
//! layout that Anchor v2 reads, and views of the organization, index, and version accounts. It does
//! no IO. The registry's tests compare each instruction with the one that Anchor builds.

mod addresses;
mod instructions;
mod state;

use sdp_intents_spec::{AccountRole, Address};

pub use addresses::{
    buffer_address, config_address, find_program_address, index_address, name_hash, organization_address,
    program_data_address, version_address, UPGRADEABLE_LOADER,
};
pub use instructions::{
    create_implementation, create_interface, create_organization, initialize_config, set_organization_authority,
    set_organizations_gated, set_registry_admin, write_buffer, Approval, IndexAuthorities, IndexChange,
    NewImplementation, NewInterface, Publication,
};
pub use state::{
    ConfigView, IndexView, OrganizationView, VersionEntry, CONFIG_DISCRIMINATOR, IMPLEMENTATION_DISCRIMINATOR,
    INDEX_DISCRIMINATOR, INTERFACE_DISCRIMINATOR, ORGANIZATION_DISCRIMINATOR, VERSION_DOCUMENT_OFFSET,
};

/// `9sgttDZ2vnzb85HWuQbx8vy6Boga32zpP5QRZ7UtbWpp`.
pub const REGISTRY_PROGRAM: Address = Address([
    131, 217, 165, 14, 242, 154, 37, 232, 205, 185, 77, 119, 196, 52, 155, 177, 116, 173, 206, 209, 58, 232, 41, 103,
    187, 187, 37, 64, 150, 138, 246, 201,
]);

/// An instruction of the registry program.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryInstruction {
    pub accounts: Vec<Meta>,
    pub data: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Meta {
    pub address: Address,
    pub role: AccountRole,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistryError {
    /// No bump puts the address off the curve.
    NoAddress,
    /// The account data is not the layout that its owner writes.
    WrongAccount,
    /// The document is longer than a buffer holds.
    DocumentTooLarge,
}

impl core::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::NoAddress => f.write_str("no bump puts the registry address off the curve"),
            Self::WrongAccount => f.write_str("the account is not a registry account of this kind"),
            Self::DocumentTooLarge => f.write_str("the document is longer than a registry buffer holds"),
        }
    }
}

impl std::error::Error for RegistryError {}
