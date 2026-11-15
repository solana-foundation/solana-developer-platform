//! A plan of one step of a flow (`DESIGN.md`, 4.19). Its `verify_intent` carries the step's
//! position and the flow's own intent, so the message can name the flow, and the signer's verifier
//! checks that the step is the one that the flow names, with the inputs that the flow binds.

use sdp_intents_engine::{Chain, Payers, Recipe};
use sdp_intents_spec::wire::{DocumentIdV1, DocumentKind, StepInputV1};
use sdp_intents_spec::{Address, Implementation, Intent, RecipeKind, ValueRef, ValueSource};

use crate::registry::version_address;
use crate::render::Column;
use crate::values::Values;
use crate::PlanError;

/// The flow that a plan of one step belongs to: the flow's interface and implementation, the
/// flow's own intent, and the step's position, from zero.
#[derive(Clone, Copy, Debug)]
pub struct FlowStep<'a> {
    pub interface: &'a [u8],
    pub implementation: &'a [u8],
    pub intent: &'a [u8],
    pub step: u8,
}

/// What the message says of the flow: `step <i> of <n>`, and the flow's id and outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FlowPart {
    pub(crate) step: u8,
    pub(crate) steps: usize,
    pub(crate) id: String,
    pub(crate) outcome: String,
}

/// The flow part, or the accounts that rendering it still needs.
pub(crate) enum FlowRender {
    Missing(Vec<Address>),
    Rendered(FlowPart),
}

impl FlowStep<'_> {
    /// `verify_intent` carries the step's position, then the flow's intent.
    pub(crate) fn data(&self) -> Vec<u8> {
        [&[self.step][..], self.intent].concat()
    }

    /// The version accounts of the flow's interface and implementation, which the flow's intent
    /// names.
    pub(crate) fn version_addresses(intent: &Intent<'_>) -> Result<[Address; 2], PlanError> {
        Ok([
            version_address(DocumentKind::Interface, intent.interface())?,
            version_address(DocumentKind::Implementation, intent.implementation())?,
        ])
    }

    /// The step is the flow's step at its position: the same interface and implementation, at a
    /// version that the flow accepts, and each input as the flow binds it.
    pub(crate) fn check_binding(&self, step: &Intent<'_>, payers: Payers<'_>) -> Result<(), PlanError> {
        let flow = Implementation::parse(self.implementation)?;
        let outer = Intent::parse(self.intent)?;
        let wrong = || PlanError::NotTheFlowStep(self.step);

        if flow.recipe()? != RecipeKind::Flow || outer.implementation() != flow.id() {
            return Err(wrong());
        }

        let named = flow.steps()?.get(usize::from(self.step)).ok_or_else(wrong)?;
        let pinned =
            accepts(&named.interface.id, step.interface()) && accepts(&named.implementation.id, step.implementation());
        let bound = flow.step_inputs(named)?.iter().zip(0u8..).try_fold(true, |bound, (input, index)| {
            Ok::<_, PlanError>(bound && self.binds(&flow, &outer, input, step.input(index)?, payers)?)
        })?;

        match pinned && bound {
            true => Ok(()),
            false => Err(wrong()),
        }
    }

    /// The flow input, payer, or literal that the flow binds to a step input equals what the step's
    /// intent holds. A value that only a plan knows cannot be checked, so it never binds.
    fn binds(
        &self,
        flow: &Implementation<'_>,
        outer: &Intent<'_>,
        input: &StepInputV1,
        held: &[u8],
        payers: Payers<'_>,
    ) -> Result<bool, PlanError> {
        let value = ValueRef::try_from(input.value)?;

        Ok(match value.source {
            ValueSource::Input => outer.input(value.index)? == held,
            ValueSource::Payer if value.index == 0 => held == payers.fee.0,
            ValueSource::Payer => held == payers.rent.0,
            ValueSource::Literal => {
                let literal =
                    flow.literals()?.get(usize::from(value.index)).ok_or(PlanError::NotTheFlowStep(self.step))?;

                flow.text(literal.bytes)? == held
            }
            ValueSource::None => held == [0],
            _ => false,
        })
    }

    /// Renders the flow's outcome from the flow's documents and intent.
    pub(crate) fn render<C: Chain>(&self, payers: Payers<'_>, chain: &C) -> Result<FlowRender, PlanError> {
        let recipe = Recipe::parse(self.interface, self.implementation, self.intent, payers)?;
        let values = Values { recipe: &recipe, chain, outputs: &[] };
        let missing: Vec<Address> =
            values.message_accounts()?.into_iter().filter(|address| chain.account(address).is_none()).collect();

        if !missing.is_empty() {
            return Ok(FlowRender::Missing(missing));
        }

        let implementation = recipe.implementation();
        let id = implementation.id();
        let version = format!("{}.{}.{}", id.version.major.get(), id.version.minor.get(), id.version.patch.get());

        Ok(FlowRender::Rendered(FlowPart {
            step: self.step,
            steps: implementation.steps()?.len(),
            id: format!(
                "{}/{}@{version}",
                values.organization(&id.publisher)?,
                crate::plan::printable(implementation.name()?)?
            ),
            outcome: values.render(implementation.message()?, Column::Message)?,
        }))
    }
}

/// `named` holds the lowest version that the flow accepts. A later minor or patch of the same major
/// version is accepted, as a caret range is.
fn accepts(named: &DocumentIdV1, held: &DocumentIdV1) -> bool {
    let version = |id: &DocumentIdV1| (id.version.major.get(), id.version.minor.get(), id.version.patch.get());

    named.publisher == held.publisher
        && named.name_hash == held.name_hash
        && named.version.major.get() == held.version.major.get()
        && version(held) >= version(named)
}

#[cfg(test)]
mod tests {
    use sdp_intents_compiler::Catalog;

    use super::*;
    use crate::test_support::{account, organization_address, PAYER};

    const DEFINITIONS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../definitions/solana.org");
    const FROM: &str = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const TO: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

    fn read(path: &str) -> String {
        std::fs::read_to_string(format!("{DEFINITIONS}/{path}")).unwrap()
    }

    /// The shield-and-transfer flow and its documents, compiled.
    fn catalog() -> Catalog {
        let mut catalog = Catalog::default().with_publisher("solana.org", organization_address());
        catalog.compile_circuit(&read("circuits/privacy-rings-confidential/1.0.0.json")).unwrap();
        for interface in ["token.transfer", "private.shield"] {
            catalog.compile_interface(&read(&format!("interfaces/{interface}/1.0.0.json"))).unwrap();
        }
        for implementation in ["privacy-rings-shield", "privacy-rings-transfer", "privacy-rings-shield-and-transfer"] {
            catalog.compile_implementation(&read(&format!("implementations/{implementation}/1.0.0.json"))).unwrap();
        }

        catalog
    }

    fn intent(catalog: &Catalog, interface: &str, implementation: &str, inputs: &str) -> Vec<u8> {
        let text = format!(
            r#"{{ "spec": "sdp-intents@1.0", "kind": "intent", "interface": "solana.org/{interface}@^1",
                "implementation": "solana.org/{implementation}@^1", "inputs": {inputs} }}"#
        );

        catalog.compile_intent(&text).unwrap().bytes
    }

    #[test]
    fn a_step_binds_to_its_flow_only_with_the_inputs_that_the_flow_binds() {
        let catalog = catalog();
        let flow_intent = intent(
            &catalog,
            "token.transfer",
            "privacy-rings-shield-and-transfer",
            &format!(
                r#"{{ "from": "{FROM}", "to": "{TO}", "mint": "11111111111111111111111111111111", "amount": "5" }}"#
            ),
        );
        let shield = |amount: &str| {
            intent(
                &catalog,
                "private.shield",
                "privacy-rings-shield",
                &format!(
                    r#"{{ "owner": "{FROM}", "mint": "11111111111111111111111111111111", "amount": "{amount}" }}"#
                ),
            )
        };
        let interface_bytes = catalog_bytes(&catalog, "token.transfer");
        let implementation_bytes = catalog_bytes(&catalog, "privacy-rings-shield-and-transfer");
        let payer = account(PAYER);
        let payers = Payers { fee: &payer, rent: &payer };
        let step = |position| FlowStep {
            interface: &interface_bytes,
            implementation: &implementation_bytes,
            intent: &flow_intent,
            step: position,
        };

        let matching = shield("5");
        let other_amount = shield("6");
        assert_eq!(step(0).check_binding(&Intent::parse(&matching).unwrap(), payers), Ok(()));
        assert_eq!(
            step(0).check_binding(&Intent::parse(&other_amount).unwrap(), payers),
            Err(PlanError::NotTheFlowStep(0))
        );
        assert_eq!(
            step(1).check_binding(&Intent::parse(&matching).unwrap(), payers),
            Err(PlanError::NotTheFlowStep(1))
        );
    }

    fn catalog_bytes(catalog: &Catalog, name: &str) -> Vec<u8> {
        catalog
            .interfaces()
            .map(|interface| (interface.id.name.clone(), interface.bytes.clone()))
            .chain(
                catalog
                    .implementations()
                    .map(|implementation| (implementation.id.name.clone(), implementation.bytes.clone())),
            )
            .find(|(found, _)| found == name)
            .map(|(_, bytes)| bytes)
            .unwrap()
    }
}
