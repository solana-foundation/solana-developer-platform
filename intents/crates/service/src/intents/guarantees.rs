//! A flow's guarantees, proved again from the exact step versions that a request pins. The
//! compiler proves them from the versions it knew, and a later step version can state less.

use sdp_intents_compiler::IdRange;
use sdp_intents_spec::{
    check_flow_guarantees, FlowDocuments, GuaranteeError, Implementation, Interface, StepDocuments,
};

use super::{IndexKind, Pin};
use crate::error::ServiceError;
use crate::registry::{IntentReference, Registry};
use crate::Service;

/// `request_pins` are the flow's interface and implementation. `step_pins` are each step's and each
/// recovery's interface and implementation, in the flow's order.
pub(super) async fn check_pinned(
    service: &Service,
    request_pins: &[Pin],
    step_pins: &[Pin],
) -> Result<(), ServiceError> {
    let references = pairs(request_pins)
        .chain(pairs(step_pins))
        .map(|[interface, implementation]| {
            Ok(IntentReference {
                interface: IdRange::parse(&interface.id).map_err(ServiceError::invalid_request)?,
                implementation: IdRange::parse(&implementation.id).map_err(ServiceError::invalid_request)?,
                allow_unapproved: true,
            })
        })
        .collect::<Result<Vec<_>, ServiceError>>()?;
    let documents = Registry { chain: &service.chain }.intent_documents(&references).await?;
    let unreadable = |error| ServiceError::refused("badDocument", format!("a flow document does not read: {error}"));

    let [flow, steps @ ..] = documents.as_slice() else {
        return Err(ServiceError::refused("flow", "the flow request names no implementation"));
    };
    let flow_documents = FlowDocuments {
        interface: Interface::parse(&flow.interface.bytes).map_err(unreadable)?,
        flow: Implementation::parse(&flow.implementation.bytes).map_err(unreadable)?,
    };
    let inputs = flow_documents
        .flow
        .steps()
        .map_err(unreadable)?
        .iter()
        .map(|step| {
            let recovery = (!step.recover.is_empty()).then(|| flow_documents.flow.recover_inputs(step)).transpose()?;

            Ok([Some(flow_documents.flow.step_inputs(step)?), recovery])
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(unreadable)?;

    let step_documents = steps
        .iter()
        .zip(inputs.into_iter().flatten().flatten())
        .map(|(documents, inputs)| {
            Ok(StepDocuments {
                interface: Interface::parse(&documents.interface.bytes)?,
                implementation: Implementation::parse(&documents.implementation.bytes)?,
                inputs,
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(unreadable)?;

    match check_flow_guarantees(flow_documents, &step_documents) {
        Ok(()) => Ok(()),
        Err(GuaranteeError::Unproved { condition }) => Err(ServiceError::refused(
            "unprovedGuarantee",
            format!(
                "the pinned steps do not guarantee `{}`, so the flow cannot start",
                guarantee_text(flow_documents, condition)
            ),
        )),
        Err(error) => Err(ServiceError::refused("unprovedGuarantee", format!("{error:?}"))),
    }
}

/// Each interface pin with the implementation pin after it.
fn pairs(pins: &[Pin]) -> impl Iterator<Item = [&Pin; 2]> {
    pins.windows(2).filter_map(|window| match window {
        [interface, implementation]
            if interface.kind == IndexKind::Interface && implementation.kind == IndexKind::Implementation =>
        {
            Some([interface, implementation])
        }
        _ => None,
    })
}

fn guarantee_text(flow: FlowDocuments<'_>, condition: usize) -> String {
    String::from_utf8_lossy(flow.guarantee_message(condition).unwrap_or_default()).into_owned()
}
