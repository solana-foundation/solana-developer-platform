//! `POST /v1/intents` and `POST /v1/intents/continue`: the loop of `DESIGN.md`, 4.1 and 4.19.
//! Each call finds the flow's position from the chain, then answers what the caller does next: sign
//! a step, wait for a condition, or nothing, because the flow is done. The service keeps no state:
//! everything that the chain cannot show is in `progress`, which the caller sends back.

mod conditions;
mod flow;
mod guarantees;
mod progress;

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use sdp_intents_client::remote;
use sdp_intents_compiler::{format_version, IdRange};
use sdp_intents_planner::{RemoteAnswer, ShieldedCall};

use crate::error::ServiceError;
use crate::flows::{prepare_step, Prepared};
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
    crate::flows::check_request(service, &request).await?;

    let unpinned = Progress { v: VERSION, request, pins: Vec::new(), steps: BTreeMap::new() };
    let pinned = pins(service, &unpinned).await?;
    let warnings = deprecation_warnings(service, &pinned).await?;
    let pins = pinned.into_iter().map(|pin| pin.id).collect();

    let mut answered =
        advance(service, Progress { pins, ..unpinned }, Advance { signatures: Vec::new(), built: None, tamper })
            .await?;
    if let Some(answered) = answered.as_object_mut() {
        answered.insert("warnings".to_owned(), Value::from(warnings));
    }

    Ok(answered)
}

/// A body of `{ progress, signatures?, built? }`. `signatures` holds one entry for each step of the
/// last `sign`, in order. `built` is the spend that the caller's wallet built for the last `build`.
pub async fn resume(service: &Service, body: &Value, tamper: bool) -> Result<Value, ServiceError> {
    let progress = Progress::read(body.get("progress"))?;
    let signatures = strings(body.get("signatures"), "signatures")?;

    let built = match body.get("built") {
        Some(built) => Some(Built::read(service, built).await?),
        None => None,
    };

    advance(service, progress, Advance { signatures, built, tamper }).await
}

/// What one call adds to the flow.
struct Advance {
    signatures: Vec<String>,
    built: Option<Built>,
    tamper: bool,
}

/// A shielded spend that the caller's wallet built: its pool instructions, which the planner checks
/// as a remote recipe's, and the accounts that the pool creates for its nullifiers. The caller can
/// lie only about its own flow: false nullifier accounts make a `spent` condition wrong for it.
struct Built {
    answer: RemoteAnswer,
    nullifier_accounts: Vec<String>,
}

impl Built {
    async fn read(service: &Service, built: &Value) -> Result<Self, ServiceError> {
        let answer = remote::read_answer(built)?;
        let tables = crate::flows::lookup_tables(&service.chain, &answer.lookup_tables()).await?;
        let nullifier_accounts = strings(built.get("nullifierAccounts"), "nullifierAccounts")?;

        Ok(Self { answer: answer.read(&tables)?, nullifier_accounts })
    }
}

/// A list of strings, or none when the key is absent. Any other value is refused, so a malformed
/// entry is never dropped.
fn strings(listed: Option<&Value>, key: &str) -> Result<Vec<String>, ServiceError> {
    let refused = || ServiceError::invalid_request(format!("`{key}` is a list of strings"));

    match listed {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => {
            items.iter().map(|item| item.as_str().map(str::to_owned).ok_or_else(refused)).collect()
        }
        Some(_) => Err(refused()),
    }
}

async fn advance(service: &Service, mut progress: Progress, call: Advance) -> Result<Value, ServiceError> {
    let steps = steps(service, &progress).await?;
    let names: Vec<String> = steps.names().into_iter().map(str::to_owned).collect();
    record_signatures(&mut progress, &names, call.signatures);

    let outcomes = Outcomes::read(service, &progress).await?;
    let current = match position(service, &steps, &progress, &outcomes).await? {
        Some(last) => last.saturating_add(1),
        None => 0,
    };
    let list = StepList { names: &names, current };

    let Some(name) = names.get(current) else {
        return answer(&progress, &list, done(&steps, &progress));
    };

    match in_flight(service, &progress, name, &outcomes).await? {
        Flight::Pending(step) => return answer(&progress, &list, sign(step)),
        Flight::Landing(until) => return answer(&progress, &list, until),
        Flight::Gone => progress.step(name).planned = None,
        Flight::Idle => {}
    }

    if let Some(ready) = steps.condition(current, Which::Ready) {
        let bound = Bound::new(ready, &Bindings { progress: &progress })?;

        if !bound.holds(service).await? {
            return answer(&progress, &list, wait(name, &bound));
        }
    }

    let at = StepAt { steps: &steps, position: current, name };
    let next = plan_step(service, &mut progress, at, call.built, call.tamper).await?;

    answer(&progress, &list, next)
}

/// The names of the request's steps, and the position of the first step that is not done.
struct StepList<'n> {
    names: &'n [String],
    current: usize,
}

impl StepList<'_> {
    /// Each step's name and state, so a caller can show the flow as a wizard.
    fn json(&self) -> Value {
        let state = |position: usize| match position.cmp(&self.current) {
            core::cmp::Ordering::Less => "done",
            core::cmp::Ordering::Equal => "current",
            core::cmp::Ordering::Greater => "pending",
        };

        self.names
            .iter()
            .enumerate()
            .map(|(position, name)| json!({ "name": name, "state": state(position) }))
            .collect()
    }

    /// After the last step lands, the request is done, so the caller need not call `continue`.
    fn then(&self) -> &'static str {
        match self.current.saturating_add(1) >= self.names.len() {
            true => "done",
            false => "continue",
        }
    }
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
async fn position(
    service: &Service,
    steps: &Steps,
    progress: &Progress,
    outcomes: &Outcomes,
) -> Result<Option<usize>, ServiceError> {
    let names = steps.names();

    for position in (0..names.len()).rev() {
        if step_done(service, steps, progress, position, outcomes).await? {
            return Ok(Some(position));
        }
    }

    Ok(None)
}

/// A step is done when its planned transaction landed, or when its `done` condition holds. Any spend
/// of the notes creates their nullifier accounts, so a `spent` condition alone does not prove that
/// this step landed.
async fn step_done(
    service: &Service,
    steps: &Steps,
    progress: &Progress,
    position: usize,
    outcomes: &Outcomes,
) -> Result<bool, ServiceError> {
    let landed = steps.names().get(position).and_then(|name| outcomes.of(name)) == Some(true);

    if landed {
        return Ok(true);
    }

    match steps.condition(position, Which::Done) {
        Some(done) if !done.contains_key("spent") => Bound::new(done, &Bindings { progress })?.holds(service).await,
        _ => Ok(false),
    }
}

/// What the cluster says of each planned step's first signature, from one status read.
struct Outcomes(BTreeMap<String, bool>);

impl Outcomes {
    async fn read(service: &Service, progress: &Progress) -> Result<Self, ServiceError> {
        let sent: Vec<(&String, solana_signature::Signature)> = progress
            .steps
            .iter()
            .filter_map(|(name, record)| Some((name, record.planned.as_ref()?.signatures.first()?)))
            .map(|(name, text)| {
                let signature =
                    text.parse().map_err(|_| ServiceError::invalid_request(format!("`{text}` is not a signature")))?;

                Ok((name, signature))
            })
            .collect::<Result<_, ServiceError>>()?;

        if sent.is_empty() {
            return Ok(Self(BTreeMap::new()));
        }

        let signatures: Vec<_> = sent.iter().map(|(_, signature)| *signature).collect();
        let outcomes = service.chain.signature_outcomes(&signatures).await?;

        Ok(Self(
            sent.iter().zip(outcomes).filter_map(|((name, _), outcome)| Some(((*name).clone(), outcome?))).collect(),
        ))
    }

    /// Whether the step's transaction landed, failed, or is unknown to the cluster.
    fn of(&self, name: &str) -> Option<bool> {
        self.0.get(name).copied()
    }
}

/// The state of a step's planned transaction.
enum Flight {
    /// Nothing is planned.
    Idle,
    /// Planned and unexpired, with no signature known: the caller gets the same step again.
    Pending(Value),
    /// Signed and unexpired: the caller waits until it lands or expires.
    Landing(Value),
    /// Failed, or expired with a signature that the cluster does not hold: the step plans again.
    Gone,
}

async fn in_flight(
    service: &Service,
    progress: &Progress,
    name: &str,
    outcomes: &Outcomes,
) -> Result<Flight, ServiceError> {
    let Some(planned) = progress.steps.get(name).and_then(|record| record.planned.as_ref()) else {
        return Ok(Flight::Idle);
    };
    if outcomes.of(name) == Some(false) {
        return Ok(Flight::Gone);
    }

    // A plan of instructions alone has no blockhash, so only the caller's signature tells whether
    // the transaction that it compiled landed.
    let Some(expires) = planned.expires else {
        return match planned.signatures.is_empty() {
            true => Err(ServiceError::refused(
                "signatureNeeded",
                format!("step `{name}` holds instructions that the caller compiled. Send the signature of that transaction."),
            )),
            false => Ok(Flight::Landing(json!({
                "kind": "wait",
                "step": name,
                "until": { "landed": planned.signatures },
                "message": format!("step `{name}` lands"),
                "checkAfter": check_after(),
            }))),
        };
    };

    let live = service.chain.block_height().await? <= expires.block_height;

    // Only the cluster's record of the signature proves that an expired step did not land. A `done`
    // condition that does not hold proves nothing: an indexer can lag, and a forester closes the
    // nullifier accounts.
    match (live, planned.signatures.is_empty()) {
        (true, true) => Ok(Flight::Pending(planned.step.clone())),
        (true, false) => Ok(Flight::Landing(landing_wait(name, planned, expires))),
        (false, false) => Ok(Flight::Gone),
        (false, true) => Err(ServiceError::refused(
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

/// The step's `sign`, or the `build` that the caller's wallet answers before the step can plan.
async fn plan_step(
    service: &Service,
    progress: &mut Progress,
    StepAt { steps, position, name }: StepAt<'_>,
    built: Option<Built>,
    tamper: bool,
) -> Result<Value, ServiceError> {
    let text = match steps {
        Steps::Single => progress.request.to_string(),
        Steps::Flow(flow) => {
            let step: &FlowStep = flow.get(position).ok_or_else(|| ServiceError::refused("flow", "no such step"))?;

            Bindings { progress }.step_request(step)?
        }
    };
    let (built, nullifier_accounts) = match built {
        Some(Built { answer, nullifier_accounts }) => (Some(answer), nullifier_accounts),
        None => (None, Vec::new()),
    };
    let prepared = match prepare_step(service, &text, tamper, built).await? {
        Prepared::Step(prepared) => prepared,
        Prepared::Build(spend) => return Ok(build(name, &spend)),
    };
    let step = sign_step(prepared.json, name);

    let record = progress.step(name);
    record.plan.nullifier_accounts = nullifier_accounts;
    record.planned = Some(PlannedStep {
        step: step.clone(),
        expires: prepared.facts.last_valid_block_height.map(|block_height| Expiry { block_height }),
        signatures: Vec::new(),
    });

    Ok(sign(step))
}

/// Asks the caller to have its wallet build `spend`, and to call `continue` with what it built.
fn build(name: &str, spend: &ShieldedCall) -> Value {
    json!({ "kind": "build", "step": name, "spend": crate::shielded::spend_json(spend) })
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

/// A `sign` says whether the caller calls `continue` after its transactions land.
fn answer(progress: &Progress, list: &StepList<'_>, mut next: Value) -> Result<Value, ServiceError> {
    let pending_until = progress
        .steps
        .values()
        .filter_map(|record| record.planned.as_ref()?.expires)
        .map(|expires| expires.block_height)
        .max();

    if let Some(sign) = next.as_object_mut().filter(|next| next.get("kind").and_then(Value::as_str) == Some("sign")) {
        sign.insert("then".to_owned(), Value::from(list.then()));
    }

    Ok(json!({
        "progress": progress.json()?,
        "steps": list.json(),
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
async fn pins(service: &Service, progress: &Progress) -> Result<Vec<Pin>, ServiceError> {
    let intents = progress.request.get("intents").and_then(Value::as_array).cloned().unwrap_or_default();
    let ranges: Vec<(IndexKind, String)> = intents
        .iter()
        .flat_map(|intent| {
            [(IndexKind::Interface, intent.get("interface")), (IndexKind::Implementation, intent.get("implementation"))]
        })
        .filter_map(|(kind, range)| Some((kind, range?.as_str()?.to_owned())))
        .collect();
    let request_pins = exact_all(service, &ranges).await?;
    let ids = |pins: &[Pin]| pins.iter().map(|pin| pin.id.clone()).collect::<Vec<_>>();

    let pinned = Progress { pins: ids(&request_pins), ..progress.clone() };
    let Steps::Flow(flow) = steps(service, &pinned).await? else {
        return Ok(request_pins);
    };

    let step_ranges: Vec<(IndexKind, String)> = flow
        .iter()
        .flat_map(|step| [Some(&step.intent), step.recover.as_ref()])
        .flatten()
        .flat_map(|intent| {
            [
                (IndexKind::Interface, Some(intent.interface.clone())),
                (IndexKind::Implementation, intent.implementation.clone()),
            ]
        })
        .filter_map(|(kind, range)| Some((kind, range?)))
        .collect();
    let step_pins = exact_all(service, &step_ranges).await?;

    check_step_tiers(&request_pins, &step_pins)?;
    guarantees::check_pinned(service, &request_pins, &step_pins).await?;

    Ok(request_pins.into_iter().chain(step_pins).collect())
}

/// One warning for each deprecated document that the request pins, with its replacement.
async fn deprecation_warnings(service: &Service, pins: &[Pin]) -> Result<Vec<String>, ServiceError> {
    let replacements: Vec<_> = pins.iter().filter_map(|pin| pin.deprecation?.replaced_by).collect();
    let ids = crate::resources::index_ids(&service.chain, &replacements).await?;

    Ok(pins
        .iter()
        .filter(|pin| pin.deprecation.is_some())
        .map(|pin| {
            let deprecation = crate::resources::deprecation_json(pin.deprecation, &ids);

            crate::resources::deprecation_warning(&pin.id, &deprecation)
        })
        .collect())
}

/// A flow's index entry holds the worst tier of its steps when it was published. A step version
/// published later above that tier is refused, so the interface's approval keeps its meaning.
fn check_step_tiers(request_pins: &[Pin], step_pins: &[Pin]) -> Result<(), ServiceError> {
    let flow = request_pins
        .iter()
        .find(|pin| pin.kind == IndexKind::Implementation)
        .ok_or_else(|| ServiceError::refused("flow", "the flow request names no implementation"))?;
    let above = step_pins.iter().find(|pin| pin.kind == IndexKind::Implementation && pin.tier > flow.tier);

    match above {
        Some(step) => Err(ServiceError::refused(
            "stepTier",
            format!("{} is tier {}, above the tier {} of the flow {}", step.id, step.tier, flow.tier, flow.id),
        )),
        None => Ok(()),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IndexKind {
    Interface,
    Implementation,
}

/// An exact version, such as `solana.org/privacy-rings-shield@1.0.0`, its index entry's tier, and
/// the index's deprecation.
struct Pin {
    kind: IndexKind,
    id: String,
    tier: u8,
    deprecation: Option<sdp_intents_registry_client::Deprecation>,
}

/// The version that each range, such as `solana.org/privacy-rings-shield@^1`, picks, from one read
/// of the indexes.
async fn exact_all(service: &Service, ranges: &[(IndexKind, String)]) -> Result<Vec<Pin>, ServiceError> {
    let parsed = ranges
        .iter()
        .map(|(kind, range)| Ok((*kind, IdRange::parse(range).map_err(ServiceError::invalid_request)?)))
        .collect::<Result<Vec<_>, ServiceError>>()?;
    let keys = parsed
        .iter()
        .map(|(kind, range)| match kind {
            IndexKind::Interface => IndexKey::interface(&range.id),
            IndexKind::Implementation => IndexKey::implementation(&range.id),
        })
        .collect();
    let indexes = Registry { chain: &service.chain }.indexes(keys).await?;

    parsed
        .into_iter()
        .zip(indexes)
        .map(|((kind, range), index)| {
            let view = index.view()?;
            let entry = pick(&view, &range)?;

            let id = format!("{}@{}", range.id, format_version(entry.version));

            Ok(Pin { kind, id, tier: entry.tier, deprecation: view.deprecation() })
        })
        .collect()
}

fn check_after() -> String {
    let now = SystemTime::now();

    iso_time(now.checked_add(CHECK_AFTER).unwrap_or(now))
}

/// `2026-11-14T20:00:00Z`.
fn iso_time(time: SystemTime) -> String {
    sdp_intents_planner::utc_time(time.duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs()))
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

    #[test]
    fn reads_a_list_of_strings_and_refuses_any_other_entry() {
        assert_eq!(strings(Some(&json!(["a", "b"])), "signatures").unwrap(), ["a", "b"]);
        assert_eq!(strings(None, "signatures").unwrap(), Vec::<String>::new());
        assert!(strings(Some(&json!(["a", 1])), "signatures").is_err());
        assert!(strings(Some(&json!("a")), "signatures").is_err());
    }

    #[test]
    fn lists_each_steps_state_and_says_when_the_last_step_ends_the_request() {
        let names = ["shield".to_owned(), "transfer".to_owned()];
        let first = StepList { names: &names, current: 0 };
        let last = StepList { names: &names, current: 1 };

        assert_eq!(
            first.json(),
            json!([{ "name": "shield", "state": "current" }, { "name": "transfer", "state": "pending" }])
        );
        assert_eq!(first.then(), "continue");
        assert_eq!(last.then(), "done");
        assert_eq!(StepList { names: &names, current: 2 }.json()[1]["state"], "done");
    }

    fn pin(kind: IndexKind, id: &str, tier: u8) -> Pin {
        Pin { kind, id: id.to_owned(), tier, deprecation: None }
    }

    #[test]
    fn refuses_a_step_implementation_above_the_flows_tier() {
        let request =
            [pin(IndexKind::Interface, "o/token.transfer@1.0.0", 0), pin(IndexKind::Implementation, "o/flow@1.0.0", 2)];
        let within = [
            pin(IndexKind::Interface, "o/private.shield@1.0.0", 0),
            pin(IndexKind::Implementation, "o/shield@1.0.0", 2),
        ];
        let above = [pin(IndexKind::Implementation, "o/shield@1.1.0", 3)];

        assert!(check_step_tiers(&request, &within).is_ok());
        assert_eq!(check_step_tiers(&request, &above).unwrap_err().code, "stepTier");
    }
}
