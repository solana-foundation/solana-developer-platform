use sdp_intents_spec::wire::{DocumentIdV1, DocumentKind, FlowDocV1, ImplementationDocV1, LiteralV1};
use sdp_intents_spec::{Implementation, RecipeKind};

use super::recipe::Recipe;
use super::Build;
use crate::diagnostic::{Code, Diagnostic};
use crate::envelope::Envelope;
use crate::limits;
use crate::resolve::InterfaceMatch;
use crate::writer::Writer;

impl Build<'_, '_> {
    pub(super) fn write(
        &mut self,
        envelope: &Envelope,
        implements: &InterfaceMatch<'_>,
        message: &[u8],
        recipe: Recipe,
        cluster: sdp_intents_spec::Address,
    ) -> Option<Vec<u8>> {
        let name = self.pool.add(envelope.id.name.as_bytes());
        let message = self.pool.add(message);
        let url = self.pool.add(&recipe.url);
        limits::check(self.sink, "", "bytes in the pool", self.pool.len(), limits::POOL_BYTES);

        let interface = implements.interface.document_id;
        let mut writer = Writer::new::<ImplementationDocV1>();
        let fixed = ImplementationDocV1 {
            id: envelope.document_id,
            implements: DocumentIdV1 { version: implements.lowest, ..interface },
            cluster,
            recipe_kind: recipe.kind.into(),
            name,
            message,
            url,
            applies: writer.table(&self.applies),
            post_conditions: writer.table(&self.post_conditions),
            addresses: writer.table(self.addresses.as_slice()),
            accounts: writer.table(&self.accounts),
            seeds: writer.table(&self.seeds),
            instructions: writer.table(&self.instructions),
            instruction_accounts: writer.table(&self.instruction_accounts),
            segments: writer.table(&self.segments),
            output_bindings: writer.table(&self.output_bindings),
            literals: writer.table::<LiteralV1>(&[]),
            ..ImplementationDocV1::default()
        };

        if recipe.kind == RecipeKind::Flow {
            let flow = FlowDocV1 {
                steps: writer.table(&self.steps),
                step_inputs: writer.table(&self.step_inputs),
                conditions: writer.table(&self.conditions),
            };
            writer.extension(&flow);
        }

        let fixed = ImplementationDocV1 { pool: writer.pool(&self.pool), ..fixed };
        let header = writer.header(DocumentKind::Implementation);
        let bytes = writer.finish(&ImplementationDocV1 { header, ..fixed });
        limits::check(self.sink, "", "bytes in the document", bytes.len(), limits::DOCUMENT_BYTES);

        if let Err(error) = Implementation::parse(&bytes) {
            self.sink.push(Diagnostic::new(
                Code::Internal,
                "",
                format!("the compiled implementation does not parse: {error}"),
            ));
        }

        self.sink.is_empty().then_some(bytes)
    }
}
