//! Stopping a flow (`DESIGN.md`, 4.19). The caller sends `stop`, and the flow stops once no planned
//! step can still land, so a step and its recovery never both land. The service then plans the
//! recovery that the last landed step names, and the flow is done when it lands.

use serde_json::{json, Value};

use super::flow::{Bindings, Steps};
use super::progress::Progress;
use super::{answer, check_after, in_flight, plan_intent, sign, Built, Flight, Outcomes, PlanTarget, StepList};
use crate::error::ServiceError;
use crate::Service;

/// The flow as the call found it: its steps, and how many have landed.
#[derive(Clone, Copy)]
pub(super) struct Stopping<'s> {
    pub(super) steps: &'s Steps,
    pub(super) names: &'s [String],
    pub(super) current: usize,
    pub(super) outcomes: &'s Outcomes,
}

/// The name under which `progress` records a step's recovery.
pub(super) fn recovery_name(step: &str) -> String {
    format!("{step}.recover")
}

pub(super) async fn advance(
    service: &Service,
    mut progress: Progress,
    at: Stopping<'_>,
    built: Option<Built>,
    tamper: bool,
) -> Result<Value, ServiceError> {
    progress.stopping = true;

    let after = match progress.stopped {
        Some(after) => after,
        None => {
            if let Some(wait) = settle_in_flight(service, &mut progress, at).await? {
                let list = StepList { names: at.names, current: at.current, stopped: true };

                return answer(&progress, &list, wait);
            }

            progress.stopped = Some(at.current);
            at.current
        }
    };
    let list = StepList { names: at.names, current: after, stopped: true };
    let last = after.checked_sub(1);
    let recovery = last.and_then(|last| Some((last, at.steps.recovery(last)?, at.names.get(last)?)));

    let Some((last, intent, step_name)) = recovery else {
        return answer(&progress, &list, stopped(after, "which names no recovery"));
    };
    let name = recovery_name(step_name);

    if at.outcomes.of(&name) == Some(true) {
        return answer(&progress, &list, stopped(after, "and its recovery landed"));
    }

    match in_flight(service, &progress, &name, at.outcomes).await? {
        Flight::Pending(step) => return answer(&progress, &list, sign(step)),
        Flight::Landing(until) => return answer(&progress, &list, until),
        Flight::Gone => progress.step(&name).planned = None,
        Flight::Idle => {}
    }

    let bindings = Bindings { progress: &progress };
    let target = PlanTarget {
        text: bindings.intent_request(intent)?,
        outer: Some(bindings.pinned_request()),
        position: u8::try_from(last).map_err(|_| ServiceError::refused("flow", "a flow holds at most 127 steps"))?,
        recovery: true,
        name: &name,
    };
    let next = plan_intent(service, &mut progress, target, built, tamper).await?;

    answer(&progress, &list, next)
}

/// A wait while a planned step after the done ones can still land. A step that expired unsent
/// plans no more.
async fn settle_in_flight(
    service: &Service,
    progress: &mut Progress,
    at: Stopping<'_>,
) -> Result<Option<Value>, ServiceError> {
    for name in at.names.iter().skip(at.current) {
        match in_flight(service, progress, name, at.outcomes).await? {
            Flight::Pending(_) => {
                let expires = progress.steps.get(name).and_then(|record| record.planned.as_ref()?.expires);

                return Ok(Some(expiry_wait(name, expires.map(|expires| expires.block_height))));
            }
            Flight::Landing(until) => return Ok(Some(until)),
            Flight::Gone => progress.step(name).planned = None,
            Flight::Idle => {}
        }
    }

    Ok(None)
}

/// The caller holds a step's transaction unsigned, and anyone who signs it can land it until it
/// expires, so the flow stops only after that.
fn expiry_wait(name: &str, block_height: Option<u64>) -> Value {
    let height = block_height.map_or_else(String::new, |height| height.to_string());

    json!({
        "kind": "wait",
        "step": name,
        "until": { "expires": { "blockHeight": height } },
        "message": format!("step `{name}` can still land until block height {height}, so the flow stops after that"),
        "checkAfter": check_after(),
    })
}

fn stopped(after: usize, recovery: &str) -> Value {
    let message = match after {
        0 => "the flow stopped before any step landed, so nothing moved".to_owned(),
        after => format!("the flow stopped after step {after}, {recovery}"),
    };

    json!({ "kind": "done", "message": message })
}
