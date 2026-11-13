use std::collections::HashMap;

use sdp_intents_spec::Address;
use serde_json::Value;

use crate::diagnostic::Report;
use crate::implementation::{compile_implementation, CompiledImplementation};
use crate::intent::{compile_intent, CompiledIntent};
use crate::interface::{compile_interface, CompiledInterface};
use crate::plan::{compile_plan, CompiledPlan};

/// The documents that a file can name from outside itself: the address of each organization, the
/// interfaces, and the implementations. Compile the interfaces first, then the implementations that
/// name them, then the intents that name both. The catalog keeps each document that compiles.
///
/// The registry derives an organization's address from its name, and the caller supplies it.
#[derive(Debug, Default)]
pub struct Catalog {
    publishers: HashMap<String, Address>,
    interfaces: HashMap<String, CompiledInterface>,
    failed_interfaces: Vec<String>,
    implementations: HashMap<String, CompiledImplementation>,
}

impl Catalog {
    pub fn with_publisher(mut self, organization: &str, address: Address) -> Self {
        self.publishers.insert(organization.to_owned(), address);
        self
    }

    /// An interface with findings is kept as failed, so that each implementation of it gets one
    /// finding that says so, not `unknownInterface`.
    pub fn compile_interface(&mut self, text: &str) -> Result<&CompiledInterface, Report> {
        match compile_interface(text, self) {
            Ok(interface) => Ok(self.insert_compiled_interface(interface)),
            Err(report) => {
                self.failed_interfaces.extend(stated_id(text));
                Err(report)
            }
        }
    }

    pub fn compile_implementation(&mut self, text: &str) -> Result<&CompiledImplementation, Report> {
        let implementation = compile_implementation(text, self)?;

        Ok(self.insert_compiled_implementation(implementation))
    }

    /// Every interface that compiled, in no order.
    pub fn interfaces(&self) -> impl Iterator<Item = &CompiledInterface> {
        self.interfaces.values()
    }

    /// Every implementation that compiled, in no order.
    pub fn implementations(&self) -> impl Iterator<Item = &CompiledImplementation> {
        self.implementations.values()
    }

    pub fn compile_intent(&self, text: &str) -> Result<CompiledIntent<'_>, Report> {
        compile_intent(text, self)
    }

    /// A plan request: one or more intents that share the payers and the priority fee.
    pub fn compile_plan(&self, text: &str) -> Result<CompiledPlan<'_>, Report> {
        compile_plan(text, self)
    }

    pub(crate) fn insert_compiled_interface(&mut self, interface: CompiledInterface) -> &CompiledInterface {
        self.interfaces.entry(interface.id.to_string()).insert_entry(interface).into_mut()
    }

    pub(crate) fn insert_compiled_implementation(
        &mut self,
        implementation: CompiledImplementation,
    ) -> &CompiledImplementation {
        self.implementations.entry(implementation.id.to_string()).insert_entry(implementation).into_mut()
    }

    #[cfg(test)]
    pub(crate) fn add_failed_interface(&mut self, id: &str) {
        self.failed_interfaces.push(id.to_owned());
    }

    pub(crate) fn interface_failed(&self, id: &str) -> bool {
        self.failed_interfaces.iter().any(|failed| failed == id)
    }

    pub(crate) fn implementation(&self, id: &str) -> Option<&CompiledImplementation> {
        self.implementations.get(id)
    }

    pub(crate) fn implementation_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self.implementations.keys().map(String::as_str).collect();
        ids.sort_unstable();
        ids
    }

    pub(crate) fn publisher(&self, organization: &str) -> Option<Address> {
        self.publishers.get(organization).copied()
    }

    pub(crate) fn publisher_names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.publishers.keys().map(String::as_str).collect();
        names.sort_unstable();
        names
    }

    pub(crate) fn interface(&self, id: &str) -> Option<&CompiledInterface> {
        self.interfaces.get(id)
    }

    pub(crate) fn interface_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self.interfaces.keys().map(String::as_str).collect();
        ids.sort_unstable();
        ids
    }
}

/// The `id` that a document states, read without compiling it.
fn stated_id(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;

    value.get("id")?.as_str().map(str::to_owned)
}
