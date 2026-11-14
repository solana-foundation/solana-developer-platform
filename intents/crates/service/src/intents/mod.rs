//! `POST /v1/intents/start` and `POST /v1/intents/continue`: the loop of `DESIGN.md`, 4.1 and 4.19.
//! Each call finds the flow's position from the chain, then answers what the caller does next: sign
//! a step, wait for a condition, or nothing, because the flow is done. The service keeps no state:
//! everything that the chain cannot show is in `progress`, which the caller sends back.

mod conditions;
mod flow;
mod progress;

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use sdp_intents_compiler::{format_version, IdRange};

use crate::error::ServiceError;
use crate::flows::prepare_step;
use crate::registry::{pick, IndexKey, Registry};
use crate::Service;
use conditions::Bound;
use flow::{Bindings, FlowStep, Steps, Which};
use progress::{Expiry, PlannedStep, Progress, VERSION};

/// How long a caller waits before it asks again, when nothing tells it sooner.
const CHECK_AFTER: Duration = Duration::from_secs(2);

/// With `tamper`, the first step's transaction differs from its plan, as `flows::prepare` says.
pub async fn start(service: &Service, text: &str, tamper: bool) -> Result<Value, ServiceError> {
    let request: Value = serde_json::from_str(text)?;
    let unpinned = Progress { v: VERSION, request, pins: Vec::new(), steps: BTreeMap::new() };
    let pins = pins(service, &unpinned).await?;

    advance(service, Progress { pins, ..unpinned }, Advance { signatures: Vec::new(), tamper }).await
}

/// A body of `{ progress, signatures? }`. `signatures` holds one entry for each step of the last
/// `sign`, in order.
pub async fn resume(service: &Service, body: &Value) -> Result<Value, ServiceError> {
    let progress = Progress::read(body.get("progress"))?;
    let signatures = body
        .get("signatures")
        .and_then(Value::as_array)
        .map(|listed| listed.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();

    advance(service, progress, Advance { signatures, tamper: false }).await
}

/// What one call adds to the flow.
struct Advance {
    signatures: Vec<String>,
    tamper: bool,
}

async fn advance(service: &Service, mut progress: Progress, call: Advance) -> Result<Value, ServiceError> {
    let steps = steps(service, &progress).await?;
    let names: Vec<String> = steps.names().into_iter().map(str::to_owned).collect();
    record_signatures(&mut progress, &names, call.signatures);

    let next = match position(service, &steps, &progress).await? {
        Some(last) => last.saturating_add(1),
        None => 0,
    };

    let Some(name) = names.get(next) else {
        return answer(&progress, done(&steps, &progress));
    };

    match in_flight(service, &steps, &progress, next, name).await? {
        Flight::Pending(step) => return answer(&progress, sign(step)),
        Flight::Landing(until) => return answer(&progress, until),
        Flight::Gone => progress.step(name).planned = None,
        Flight::Idle => {}
    }

    if let Some(ready) = steps.condition(next, Which::Ready) {
        let bound = Bound::new(ready, &Bindings { progress: &progress })?;

        if !bound.holds(service).await? {
            return answer(&progress, wait(name, &bound));
        }
    }

    let at = StepAt { steps: &steps, position: next, name };
    let step = plan_step(service, &mut progress, at, call.tamper).await?;

    answer(&progress, sign(step))
}

/// The signatures of the last `sign` belong to the first step that is planned and unsigned.
fn record_signatures(progress: &mut Progress, names: &[String], signatures: Vec<String>) {
    if signatures.is_empty() {
        return;
    }

    let unsigned = names.iter().find(|name| {
        progress
            .steps
            .get(name.as_str())
            .and_then(|record| record.planned.as_ref())
            .is_some_and(|planned| planned.signatures.is_empty())
    });

    if let Some(planned) = unsigned.cloned().and_then(|name| progress.step(&name).planned.as_mut()) {
        planned.signatures = signatures;
    }
}

/// The last step that is done, scanning from the end, so that a condition can turn false again,
/// such as a balance that a later step spends.
async fn position(service: &Service, steps: &Steps, progress: &Progress) -> Result<Option<usize>, ServiceError> {
    let names = steps.names();

    for position in (0..names.len()).rev() {
        if step_done(service, steps, progress, position).await? {
            return Ok(Some(position));
        }
    }

    Ok(None)
}

/// A step is done when its `done` condition holds, or when its planned transaction landed.
async fn step_done(
    service: &Service,
    steps: &Steps,
    progress: &Progress,
    position: usize,
) -> Result<bool, ServiceError> {
    if let Some(done) = steps.condition(position, Which::Done) {
        if Bound::new(done, &Bindings { progress })?.holds(service).await? {
            return Ok(true);
        }
    }

    let planned = steps.names().get(position).and_then(|name| progress.steps.get(*name)?.planned.as_ref());

    Ok(match planned {
        Some(planned) => landed(service, planned).await? == Some(true),
        None => false,
    })
}

/// What the cluster says of the planned transaction's first signature, when the caller sent it.
async fn landed(service: &Service, planned: &PlannedStep) -> Result<Option<bool>, ServiceError> {
    let signatures = planned
        .signatures
        .iter()
        .map(|text| text.parse().map_err(|_| ServiceError::invalid_request(format!("`{text}` is not a signature"))))
        .collect::<Result<Vec<solana_signature::Signature>, _>>()?;

    if signatures.is_empty() {
        return Ok(None);
    }

    Ok(service.chain.signature_outcomes(&signatures).await?.first().copied().flatten())
}

/// The state of a step's planned transaction.
enum Flight {
    /// Nothing is planned.
    Idle,
    /// Planned and unexpired, with no signature known: the caller gets the same step again.
    Pending(Value),
    /// Signed and unexpired: the caller waits until it lands or expires.
    Landing(Value),
    /// Expired, or failed: the step plans again.
    Gone,
}

async fn in_flight(
    service: &Service,
    steps: &Steps,
    progress: &Progress,
    position: usize,
    name: &str,
) -> Result<Flight, ServiceError> {
    let Some(planned) = progress.steps.get(name).and_then(|record| record.planned.as_ref()) else {
        return Ok(Flight::Idle);
    };
    let Some(expires) = planned.expires else {
        return Ok(Flight::Gone);
    };

    if landed(service, planned).await? == Some(false) {
        return Ok(Flight::Gone);
    }

    let live = service.chain.block_height().await? <= expires.block_height;

    match (live, planned.signatures.is_empty()) {
        (true, true) => Ok(Flight::Pending(planned.step.clone())),
        (true, false) => Ok(Flight::Landing(landing_wait(name, planned, expires))),
        (false, _) if steps.condition(position, Which::Done).is_some() || !planned.signatures.is_empty() => {
            Ok(Flight::Gone)
        }
        (false, _) => Err(ServiceError::refused(
            "signatureNeeded",
            format!(
                "step `{name}` expired, and without its signature the service cannot tell whether it landed. \
                 Send the signature, or start again."
            ),
        )),
    }
}

/// One step of the request, by its position and its name.
struct StepAt<'s> {
    steps: &'s Steps,
    position: usize,
    name: &'s str,
}

async fn plan_step(
    service: &Service,
    progress: &mut Progress,
    StepAt { steps, position, name }: StepAt<'_>,
    tamper: bool,
) -> Result<Value, ServiceError> {
    let text = match steps {
        Steps::Single => progress.request.to_string(),
        Steps::Flow(flow) => {
            let step: &FlowStep = flow.get(position).ok_or_else(|| ServiceError::refused("flow", "no such step"))?;

            Bindings { progress }.step_request(step)?
        }
    };
    let prepared = prepare_step(service, &text, tamper).await?;
    let step = sign_step(prepared.json, name);

    let record = progress.step(name);
    record.plan.nullifiers =
        prepared.facts.nullifiers.iter().map(|nullifier| bs58::encode(nullifier).into_string()).collect();
    record.planned = Some(PlannedStep {
        step: step.clone(),
        expires: prepared.facts.last_valid_block_height.map(|block_height| Expiry { block_height }),
        signatures: Vec::new(),
    });

    Ok(step)
}

/// A plan as a step of a `sign`: its own fields, without the plan's envelope, which `progress`
/// already holds.
fn sign_step(mut plan: Value, name: &str) -> Value {
    if let Some(object) = plan.as_object_mut() {
        ["spec", "kind", "request"].iter().for_each(|key| {
            object.remove(*key);
        });
        object.insert("name".to_owned(), Value::from(name));
        object.insert("signs".to_owned(), Value::from("transaction"));
    }

    plan
}

fn sign(step: Value) -> Value {
    json!({ "kind": "sign", "land": "inOrder", "steps": [step] })
}

fn wait(name: &str, bound: &Bound) -> Value {
    json!({
        "kind": "wait",
        "step": name,
        "until": bound.json(),
        "message": bound.message.clone().unwrap_or_else(|| format!("step `{name}` waits for its condition")),
        "checkAfter": check_after(),
    })
}

fn landing_wait(name: &str, planned: &PlannedStep, expires: Expiry) -> Value {
    json!({
        "kind": "wait",
        "step": name,
        "until": { "landed": planned.signatures, "expires": { "blockHeight": expires.block_height.to_string() } },
        "message": format!("step `{name}` lands, or expires at block height {}", expires.block_height),
        "checkAfter": check_after(),
    })
}

fn done(steps: &Steps, progress: &Progress) -> Value {
    let last = steps.names().len().saturating_sub(1);
    let message = steps
        .condition(last, Which::Done)
        .and_then(|done| done.get("message"))
        .and_then(Value::as_str)
        .map(|template| Bindings { progress }.render(template))
        .unwrap_or_else(|| "every step landed".to_owned());

    json!({ "kind": "done", "message": message })
}

fn answer(progress: &Progress, next: Value) -> Result<Value, ServiceError> {
    let pending_until = progress
        .steps
        .values()
        .filter_map(|record| record.planned.as_ref()?.expires)
        .map(|expires| expires.block_height)
        .max();

    Ok(json!({
        "progress": progress.json()?,
        "next": next,
        "pendingUntil": pending_until.map(|block_height| json!({ "blockHeight": block_height.to_string() })),
    }))
}

/// The request's steps. A request of one intent whose implementation is a flow has the flow's steps.
async fn steps(service: &Service, progress: &Progress) -> Result<Steps, ServiceError> {
    let intents = progress.request.get("intents").and_then(Value::as_array).cloned().unwrap_or_default();
    let [intent] = intents.as_slice() else {
        return Ok(Steps::Single);
    };
    let Some(range) = intent.get("implementation").and_then(Value::as_str) else {
        return Ok(Steps::Single);
    };
    let id = range.split_once('@').map_or(range, |(id, _)| id);
    let Some(exact) = progress.pinned(id) else {
        return Ok(Steps::Single);
    };

    let pinned = IdRange::parse(exact).map_err(ServiceError::invalid_request)?;
    let published =
        crate::resources::version(&service.chain, IndexKey::implementation(&pinned.id), pinned.lowest).await?;

    match published.pointer("/document/recipe/kind").and_then(Value::as_str) {
        Some("flow") => {
            let listed = published.pointer("/document/recipe/steps").cloned().unwrap_or_default();
            let flow: Vec<FlowStep> = serde_json::from_value(listed)
                .map_err(|error| ServiceError::refused("flow", format!("the flow's steps do not read: {error}")))?;

            Ok(Steps::Flow(flow))
        }
        _ => Ok(Steps::Single),
    }
}

/// The exact version of each interface and implementation that the request and its flow name, so
/// that a new version cannot change a flow that has started.
async fn pins(service: &Service, progress: &Progress) -> Result<Vec<String>, ServiceError> {
    let intents = progress.request.get("intents").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut ranges: Vec<(IndexKind, String)> = intents
        .iter()
        .flat_map(|intent| {
            [(IndexKind::Interface, intent.get("interface")), (IndexKind::Implementation, intent.get("implementation"))]
        })
        .filter_map(|(kind, range)| Some((kind, range?.as_str()?.to_owned())))
        .collect();

    let mut pins = Vec::new();
    for (kind, range) in &ranges {
        pins.push(exact(service, *kind, range).await?);
    }

    let pinned = Progress { pins: pins.clone(), ..progress.clone() };
    if let Steps::Flow(flow) = steps(service, &pinned).await? {
        ranges = flow
            .iter()
            .flat_map(|step| {
                [
                    (IndexKind::Interface, Some(step.intent.interface.clone())),
                    (IndexKind::Implementation, step.intent.implementation.clone()),
                ]
            })
            .filter_map(|(kind, range)| Some((kind, range?)))
            .collect();

        for (kind, range) in &ranges {
            pins.push(exact(service, *kind, range).await?);
        }
    }

    Ok(pins)
}

#[derive(Clone, Copy)]
enum IndexKind {
    Interface,
    Implementation,
}

/// `solana.org/zolana-shield@1.0.0`, from a range such as `solana.org/zolana-shield@^1`.
async fn exact(service: &Service, kind: IndexKind, range: &str) -> Result<String, ServiceError> {
    let range = IdRange::parse(range).map_err(ServiceError::invalid_request)?;
    let key = match kind {
        IndexKind::Interface => IndexKey::interface(&range.id),
        IndexKind::Implementation => IndexKey::implementation(&range.id),
    };
    let index = Registry { chain: &service.chain }
        .indexes(vec![key])
        .await?
        .pop()
        .ok_or_else(|| ServiceError::not_found("unknown", format!("no index of `{}`", range.id)))?;
    let entry = pick(&index.view()?, &range)?;

    Ok(format!("{}@{}", range.id, format_version(entry.version)))
}

fn check_after() -> String {
    let now = SystemTime::now();

    iso_time(now.checked_add(CHECK_AFTER).unwrap_or(now))
}

/// `2026-11-14T20:00:00Z`.
fn iso_time(time: SystemTime) -> String {
    let seconds = time.duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs());
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    let (year, month, day) = civil_date(days);

    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3_600, rest % 3_600 / 60, rest % 60)
}

/// The proleptic Gregorian date of a count of days since 1970-01-01, after Howard Hinnant's
/// `civil_from_days`.
fn civil_date(days: u64) -> (u64, u64, u64) {
    let shifted = days.saturating_add(719_468);
    let era = shifted / 146_097;
    let day_of_era = shifted.saturating_sub(era.saturating_mul(146_097));
    let year_of_era = day_of_era
        .saturating_sub(day_of_era / 1_460)
        .saturating_add(day_of_era / 36_524)
        .saturating_sub(day_of_era / 146_096)
        / 365;
    let year_days = year_of_era.saturating_mul(365).saturating_add(year_of_era / 4).saturating_sub(year_of_era / 100);
    let day_of_year = day_of_era.saturating_sub(year_days);
    let month_index = day_of_year.saturating_mul(5).saturating_add(2) / 153;
    let day = day_of_year.saturating_sub(month_index.saturating_mul(153).saturating_add(2) / 5).saturating_add(1);
    let month = if month_index < 10 { month_index.saturating_add(3) } else { month_index.saturating_sub(9) };
    let year = year_of_era.saturating_add(era.saturating_mul(400)).saturating_add(u64::from(month <= 2));

    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flow::ONLY_STEP;

    #[test]
    fn writes_a_utc_time() {
        assert_eq!(iso_time(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(iso_time(UNIX_EPOCH + Duration::from_secs(1_794_686_400)), "2026-11-14T20:00:00Z");
    }

    #[test]
    fn the_only_step_of_a_request_is_named() {
        assert_eq!(Steps::Single.names(), vec![ONLY_STEP]);
    }
}
