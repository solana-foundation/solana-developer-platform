//! Documents that the registry holds, read back from their binary form. A service compiles intents
//! against them, so it needs no JSON source for the definitions.

use core::fmt;

use sdp_intents_spec::{Implementation, Interface, SpecError};

use crate::catalog::Catalog;
use crate::encoding::Shape;
use crate::id::Id;
use crate::implementation::CompiledImplementation;
use crate::interface::CompiledInterface;
use crate::scope::{Field, Schema};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublishedError {
    Spec(SpecError),
    /// The document's name is not UTF-8.
    Name,
    /// The catalog holds no address for the organization, or another address than the document's
    /// publisher.
    Publisher(String),
}

impl Catalog {
    /// Adds a published interface. `organization` is the name of the document's publisher.
    pub fn insert_interface(
        &mut self,
        organization: &str,
        bytes: Vec<u8>,
    ) -> Result<&CompiledInterface, PublishedError> {
        let view = Interface::parse(&bytes)?;
        let document_id = *view.id();
        let id = self.published_id(organization, &document_id.publisher, view.name()?)?;
        let field = |name, value_type, optional| -> Result<Field, PublishedError> {
            Ok(Field { name: text(view.text(name)?)?, shape: Shape { value_type, optional } })
        };

        let inputs = view
            .inputs()?
            .iter()
            .map(|input| field(input.name, input.value_type()?, input.optional()))
            .collect::<Result<_, _>>()?;
        let outputs = view
            .outputs()?
            .iter()
            .map(|output| field(output.name, output.value_type()?, false))
            .collect::<Result<_, _>>()?;

        let interface = CompiledInterface {
            id,
            version: document_id.version,
            document_id,
            schema: Schema { inputs, outputs },
            bytes,
        };

        Ok(self.insert_compiled_interface(interface))
    }

    /// Adds a published implementation. Its interface needs no entry in the catalog until an intent
    /// names both.
    pub fn insert_implementation(
        &mut self,
        organization: &str,
        bytes: Vec<u8>,
    ) -> Result<&CompiledImplementation, PublishedError> {
        let view = Implementation::parse(&bytes)?;
        let document_id = *view.id();
        let implements = *view.implements();
        let id = self.published_id(organization, &document_id.publisher, view.name()?)?;

        let implementation =
            CompiledImplementation { id, version: document_id.version, document_id, implements, bytes };

        Ok(self.insert_compiled_implementation(implementation))
    }

    fn published_id(
        &self,
        organization: &str,
        publisher: &sdp_intents_spec::Address,
        name: &[u8],
    ) -> Result<Id, PublishedError> {
        if self.publisher(organization) != Some(*publisher) {
            return Err(PublishedError::Publisher(organization.to_owned()));
        }

        Ok(Id { organization: organization.to_owned(), name: text(name)? })
    }
}

fn text(bytes: &[u8]) -> Result<String, PublishedError> {
    core::str::from_utf8(bytes).map(str::to_owned).map_err(|_| PublishedError::Name)
}

impl From<SpecError> for PublishedError {
    fn from(error: SpecError) -> Self {
        Self::Spec(error)
    }
}

impl fmt::Display for PublishedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spec(error) => write!(f, "the document does not parse: {error}"),
            Self::Name => f.write_str("the document's name is not UTF-8"),
            Self::Publisher(organization) => write!(f, "the document's publisher is not `{organization}`"),
        }
    }
}

impl std::error::Error for PublishedError {}

#[cfg(test)]
mod tests {
    use sdp_intents_spec::Address;

    use super::*;

    const INTERFACE: &str = include_str!("../../../definitions/solana.org/interfaces/token.transfer/1.0.0.json");
    const IMPLEMENTATION: &str =
        include_str!("../../../definitions/solana.org/implementations/system-transfer/1.0.0.json");
    const INTENT: &str = include_str!("../../../fixtures/intents/system-transfer.json");

    fn catalog() -> Catalog {
        Catalog::default().with_publisher("solana.org", Address([7; 32]))
    }

    /// An intent compiles to the same bytes against the published documents as against their JSON.
    #[test]
    fn an_intent_compiles_the_same_against_published_documents() {
        let mut from_json = catalog();
        let interface = from_json.compile_interface(INTERFACE).unwrap().bytes.clone();
        let implementation = from_json.compile_implementation(IMPLEMENTATION).unwrap().bytes.clone();

        let mut published = catalog();
        published.insert_interface("solana.org", interface).unwrap();
        published.insert_implementation("solana.org", implementation).unwrap();

        assert_eq!(published.compile_intent(INTENT).unwrap().bytes, from_json.compile_intent(INTENT).unwrap().bytes);
    }

    #[test]
    fn refuses_a_document_of_another_publisher() {
        let mut from_json = catalog();
        let interface = from_json.compile_interface(INTERFACE).unwrap().bytes.clone();
        let mut other = Catalog::default().with_publisher("solana.org", Address([8; 32]));

        assert_eq!(
            other.insert_interface("solana.org", interface).err(),
            Some(PublishedError::Publisher("solana.org".into()))
        );
    }
}
