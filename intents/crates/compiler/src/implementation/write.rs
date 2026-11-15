use sdp_intents_spec::wire::{DocumentIdV1, DocumentKind, FlowDocV1, ImplementationDocV1, LiteralV1};
use sdp_intents_spec::{
    check_flow_guarantees, FlowDocuments, GuaranteeError, Implementation, Interface, RecipeKind, SpecError,
    StepDocuments,
};

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

        let recipe_kind = recipe.kind;

        if recipe.kind == RecipeKind::Flow {
            let flow = FlowDocV1 {
                steps: writer.table(&self.steps),
                step_inputs: writer.table(&self.step_inputs),
                conditions: writer.table(&self.conditions),
                max_tier: self.flow_tier,
            };
            writer.extension(&flow);
        }

        if let Some(shielded) = recipe.shielded {
            writer.extension(&shielded);
        }

        let fixed = ImplementationDocV1 { pool: writer.pool(&self.pool), ..fixed };
        let header = writer.header(DocumentKind::Implementation);
        let bytes = writer.finish(&ImplementationDocV1 { header, ..fixed });
        limits::check(self.sink, "", "bytes in the document", bytes.len(), limits::DOCUMENT_BYTES);

        match Implementation::parse(&bytes) {
            Ok(compiled) if recipe_kind == RecipeKind::Flow => self.check_flow_guarantees(compiled, implements),
            Ok(_) => {}
            Err(error) => self.sink.push(Diagnostic::new(
                Code::Internal,
                "",
                format!("the compiled implementation does not parse: {error}"),
            )),
        }

        self.sink.is_empty().then_some(bytes)
    }

    /// A flow's guarantees must follow from its steps', at the versions that the catalog holds.
    /// The service checks the versions that a request pins again before it starts.
    fn check_flow_guarantees(&mut self, flow: Implementation<'_>, implements: &InterfaceMatch<'_>) {
        let Ok(interface) = Interface::parse(&implements.interface.bytes) else { return };
        let flow_documents = FlowDocuments { interface, flow };

        match flow_step_documents(flow, &self.step_documents).map(|steps| check_flow_guarantees(flow_documents, &steps))
        {
            Ok(Ok(())) => {}
            Ok(Err(GuaranteeError::Unproved { condition })) => self.sink.push(
                Diagnostic::new(
                    Code::InvalidValue,
                    "/recipe/steps",
                    format!("the steps do not guarantee `{}`", guarantee_text(flow_documents, condition)),
                )
                .help("each step's guarantees must bound the flow's: their outflows add up to at most the flow's"),
            ),
            Ok(Err(GuaranteeError::Inflow { .. })) => self.sink.push(Diagnostic::new(
                Code::InvalidValue,
                "/postConditions",
                "a flow cannot guarantee an inflow, because a flow that stops after a step has not received it",
            )),
            Ok(Err(error)) => self.sink.push(Diagnostic::new(Code::Internal, "/recipe/steps", format!("{error:?}"))),
            Err(error) => self.sink.push(Diagnostic::new(Code::Internal, "/recipe/steps", error.to_string())),
        }
    }
}

/// Each step's and each recovery's documents, with the inputs that the flow binds to them.
fn flow_step_documents<'a>(
    flow: Implementation<'a>,
    compiled: &'a [super::flow::StepCompiled<'_>],
) -> Result<Vec<StepDocuments<'a>>, SpecError> {
    let mut documents = compiled.iter();
    let mut next = |inputs| {
        let step = documents.next().ok_or(SpecError::BadIndex)?;

        Ok::<_, SpecError>(StepDocuments {
            interface: Interface::parse(&step.interface.bytes)?,
            implementation: Implementation::parse(&step.implementation.bytes)?,
            inputs,
        })
    };

    flow.steps()?.iter().try_fold(Vec::new(), |mut steps, step| {
        steps.push(next(flow.step_inputs(step)?)?);

        if !step.recover.is_empty() {
            steps.push(next(flow.recover_inputs(step)?)?);
        }

        Ok(steps)
    })
}

fn guarantee_text(flow: FlowDocuments<'_>, condition: usize) -> String {
    String::from_utf8_lossy(flow.guarantee_message(condition).unwrap_or_default()).into_owned()
}
