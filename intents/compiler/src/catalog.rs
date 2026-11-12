use std::collections::HashMap;

use sdp_intents_spec::Address;

use crate::interface::CompiledInterface;

/// What the compiler needs from outside a file: the address of each organization, and the
/// interfaces that implementations name.
///
/// The registry derives an organization's address from its name. Until the registry exists, the
/// caller supplies the addresses.
#[derive(Debug, Default)]
pub struct Catalog {
    publishers: HashMap<String, Address>,
    interfaces: HashMap<String, CompiledInterface>,
    failed_interfaces: Vec<String>,
}

impl Catalog {
    pub fn with_publisher(mut self, organization: &str, address: Address) -> Self {
        self.publishers.insert(organization.to_owned(), address);
        self
    }

    pub fn add_interface(&mut self, interface: CompiledInterface) {
        self.interfaces.insert(interface.id.to_string(), interface);
    }

    /// Marks an interface whose own file has findings. An implementation of it then gets one
    /// finding that says so, not `unknownInterface`.
    pub fn add_failed_interface(&mut self, id: &str) {
        self.failed_interfaces.push(id.to_owned());
    }

    pub fn interface_failed(&self, id: &str) -> bool {
        self.failed_interfaces.iter().any(|failed| failed == id)
    }

    pub fn publisher(&self, organization: &str) -> Option<Address> {
        self.publishers.get(organization).copied()
    }

    pub fn publisher_names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.publishers.keys().map(String::as_str).collect();
        names.sort_unstable();
        names
    }

    pub fn interface(&self, id: &str) -> Option<&CompiledInterface> {
        self.interfaces.get(id)
    }

    pub fn interface_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self.interfaces.keys().map(String::as_str).collect();
        ids.sort_unstable();
        ids
    }
}
