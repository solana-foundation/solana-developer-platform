//! `prepare` and `verify`: the planner and the verifier, answered from the cache.

use base64::Engine as _;
use serde_json::{json, Value};

use axum::http::StatusCode;
use sdp_intents_chain::{CachedRpc, Freshness};
use sdp_intents_client::message::{read_transaction, LookupTable, WireMessage};
use sdp_intents_client::{fresh_address, instructions_only, json as plan_json, prepared, remote};
use sdp_intents_compiler::{IdRange, PlanOutput};
use sdp_intents_planner::{
    verify_transaction, AccountMap, IntentDocuments, Payers, Plan, PlanRequest, Planner, ProviderSignature,
    RemoteAnswer, RemoteCall, ShieldedCall, Step, VerifiedTransaction, VerifyStep,
};
use sdp_intents_spec::Address;

use crate::error::ServiceError;
use crate::registry::{catalog, IntentReference, Registry};
use crate::Service;

/// Each `verify_intent` needs its two version accounts, then the accounts that its recipe and its
/// message read. A plan of many intents asks for each kind in one call.
const MAX_VERIFY_ROUNDS: usize = 8;

/// A plan request as `DESIGN.md`, section 4.1, writes it. The documents come from the registry.
/// With `tamper`, the transaction differs from the plan, as `tamper` says. A request for the
/// instructions alone reads no blockhash.
pub async fn prepare(service: &Service, text: &str, tamper: bool) -> Result<Value, ServiceError> {
    match prepare_step(service, text, tamper, None).await? {
        Prepared::Step(step) => Ok(step.json),
        Prepared::Build(_) => Err(needs_build()),
    }
}

/// A step's plan, or the shielded spend that the caller must build before the step can plan.
pub(crate) enum Prepared {
    Step(PreparedStep),
    Build(Box<ShieldedCall>),
}

/// A plan as JSON, and what planning it fixed.
pub(crate) struct PreparedStep {
    pub json: Value,
    pub facts: StepFacts,
}

/// What a step's plan fixes, which a flow keeps in `progress` (`DESIGN.md`, 4.19).
#[derive(Default)]
pub(crate) struct StepFacts {
    /// The last block height at which the step's transaction can land. A plan of instructions alone
    /// has none.
    pub last_valid_block_height: Option<u64>,
}

/// Plans one step. A shielded step plans only with `built`, the spend that the caller's wallet
/// built, because the service holds no key and asks no key holder.
pub(crate) async fn prepare_step(
    service: &Service,
    text: &str,
    tamper: bool,
    built: Option<RemoteAnswer>,
) -> Result<Prepared, ServiceError> {
    let request: Value = serde_json::from_str(text)?;
    let (mut plan, output) = match planned(service, text, built).await? {
        Planning::Planned(planned) => (planned.plan, planned.output),
        Planning::Build(call) => return Ok(Prepared::Build(call)),
    };

    if tamper {
        tamper_with(&mut plan);
    }

    let (prepared, expiry) = match output {
        PlanOutput::Instructions => (instructions_only(plan)?, None),
        PlanOutput::Transaction => {
            let recent = service.chain.latest_blockhash().await?;

            (prepared(plan, recent.blockhash, recent.last_valid_block_height)?, Some(recent.last_valid_block_height))
        }
    };

    let facts = StepFacts { last_valid_block_height: expiry };

    Ok(Prepared::Step(PreparedStep { json: plan_json::plan(&prepared, request), facts }))
}

struct Planned {
    plan: Plan,
    output: PlanOutput,
}

/// A plan, or the shielded spend that the planner waits for.
enum Planning {
    Planned(Box<Planned>),
    Build(Box<ShieldedCall>),
}

fn needs_build() -> ServiceError {
    ServiceError::refused(
        "needsBuild",
        "the request holds a shielded step, which the spender's wallet builds. Run it with POST /v1/intents.",
    )
}

/// Checks the request itself: its inputs compile, and each implementation's `applies` checks that
/// need no account hold. A flow plans only its steps, so without this check a flow would drop an
/// input that no step names, such as a memo.
pub async fn check_request(service: &Service, request: &Value) -> Result<(), ServiceError> {
    let references = references(request)?;
    let documents = Registry { chain: &service.chain }.intent_documents(&references).await?;
    let catalog = catalog(documents.iter().flat_map(|intent| [&intent.interface, &intent.implementation]))?;
    let text = crate::amounts::in_base_units(&service.chain, &catalog, request).await?.to_string();
    let compiled = catalog.compile_plan(&text).map_err(|report| ServiceError::compile(&report, &text))?;
    let payers = Payers { fee: &compiled.payers.fee, rent: &compiled.payers.rent };

    compiled.intents.iter().try_for_each(|intent| {
        sdp_intents_engine::Recipe::parse(&intent.interface.bytes, &intent.implementation.bytes, &intent.bytes, payers)
            .map(|_| ())
            .map_err(|error| {
                ServiceError::refused("doesNotApply", format!("the implementation refuses the intent: {error}"))
            })
    })
}

/// Plans `text` with the registry's documents. A remote call or a shielded spend takes `answer`
/// when it is set.
async fn planned(service: &Service, text: &str, answer: Option<RemoteAnswer>) -> Result<Planning, ServiceError> {
    let request: Value = serde_json::from_str(text)?;
    let references = references(&request)?;
    let documents = Registry { chain: &service.chain }.intent_documents(&references).await?;

    let catalog = catalog(documents.iter().flat_map(|intent| [&intent.interface, &intent.implementation]))?;
    let text = crate::amounts::in_base_units(&service.chain, &catalog, &request).await?.to_string();
    let compiled = catalog.compile_plan(&text).map_err(|report| ServiceError::compile(&report, &text))?;
    let plan_request = PlanRequest {
        intents: compiled
            .intents
            .iter()
            .map(|intent| IntentDocuments {
                interface: &intent.interface.bytes,
                implementation: &intent.implementation.bytes,
                intent: &intent.bytes,
            })
            .collect(),
        payers: Payers { fee: &compiled.payers.fee, rent: &compiled.payers.rent },
        priority_fee_lamports: compiled.priority_fee_lamports,
        valid_for_seconds: compiled.valid_for_seconds,
    };

    Ok(match plan(service, &plan_request, answer).await? {
        Answered::Plan(plan) => Planning::Planned(Box::new(Planned { plan: *plan, output: compiled.output })),
        Answered::Build(call) => Planning::Build(call),
    })
}

/// A body of `{ "message": base64, "expected": text }`, or of `{ "transaction": base64 }` with a
/// whole transaction in wire form, whose signatures it ignores. Either is of any version.
/// `expected` is the plan's message, when the caller has one. A provider's transaction also holds
/// `presigned` and the plan's `request`, and is planned again with the transaction as the
/// endpoint's answer.
pub async fn verify(service: &Service, body: &Value) -> Result<Value, ServiceError> {
    let chain = &service.chain;
    let message = message_of(body)?;
    let tables = lookup_tables(chain, &message.lookup_tables()).await?;
    let expected = body.get("expected").and_then(Value::as_str);
    let presigned = presigned(body)?;

    if presigned.is_empty() {
        return Ok(plan_json::verified(&verified(chain, &message.decode(&tables)?).await?, expected));
    }

    let request = body
        .get("request")
        .ok_or_else(|| ServiceError::invalid_request("a provider's transaction needs its `request`"))?;
    let frozen = remote::frozen_from_parts(&message, presigned, &tables)?;
    let answer = RemoteAnswer { frozen: Some(frozen), ..RemoteAnswer::default() };
    let replanned = match planned(service, &request.to_string(), Some(answer)).await? {
        Planning::Planned(planned) => planned.plan,
        Planning::Build(_) => return Err(needs_build()),
    };

    Ok(json!({
        "message": replanned.message,
        "matches": expected.map(|expected| expected == replanned.message),
        "intents": [],
        "unverified": [],
        "checkedBy": "simulation",
    }))
}

/// The message of `message`, or of the wire transaction in `transaction`.
pub fn message_of(body: &Value) -> Result<WireMessage, ServiceError> {
    let base64_of = |key: &str| {
        body.get(key).and_then(Value::as_str).map(|text| {
            base64::engine::general_purpose::STANDARD
                .decode(text)
                .map_err(|error| ServiceError::invalid_request(format!("`{key}` is not base64: {error}")))
        })
    };

    match (base64_of("message"), base64_of("transaction")) {
        (Some(message), None) => Ok(WireMessage::parse(&message?)?),
        (None, Some(transaction)) => Ok(read_transaction(&transaction?)?.message),
        _ => Err(ServiceError::invalid_request(
            "the body holds `message`, the base64 of a message, or `transaction`, the base64 of a transaction",
        )),
    }
}

/// The lookup tables at `addresses`, read live, because a table can grow.
pub(crate) async fn lookup_tables(chain: &CachedRpc, addresses: &[Address]) -> Result<Vec<LookupTable>, ServiceError> {
    if addresses.is_empty() {
        return Ok(Vec::new());
    }

    let fetched = chain.accounts(addresses, Freshness::Live).await?;

    Ok(addresses
        .iter()
        .zip(&fetched)
        .map(|(address, account)| LookupTable::read(*address, account.as_ref()))
        .collect::<Result<Vec<_>, _>>()?)
}

/// Changes the last data byte of the first built instruction, and keeps the message. The client's
/// verifier reads only `verify_intent`, so it still renders the plan's message, and `verify_intent`
/// refuses the transaction onchain. The playground shows that refusal.
fn tamper_with(plan: &mut Plan) {
    let first_built = plan.intents.first().map(|intent| intent.span.start);
    let byte = first_built
        .and_then(|position| plan.transaction.instructions.get_mut(position))
        .and_then(|instruction| instruction.data.last_mut());

    if let Some(byte) = byte {
        *byte = byte.wrapping_add(1);
    }
}

/// A plan, or the shielded spend that the planner waits for.
enum Answered {
    Plan(Box<Plan>),
    Build(Box<ShieldedCall>),
}

async fn plan(
    service: &Service,
    request: &PlanRequest<'_>,
    answer: Option<RemoteAnswer>,
) -> Result<Answered, ServiceError> {
    let chain = &service.chain;
    let mut planner = Planner::new(request, fresh_address())?;
    let mut accounts = AccountMap::default();

    loop {
        match planner.next(&accounts)? {
            Step::Fetch(addresses) => {
                let fetched = chain.accounts(&addresses, Freshness::Live).await?;
                accounts.insert_fetched(&addresses, fetched);
            }
            Step::Simulate(simulation) => planner.simulated(chain.simulate(&simulation, &accounts).await?)?,
            Step::Call(call) => match &answer {
                Some(answer) => planner.called(answer.clone())?,
                None => planner.called(call_remote(chain, &call).await?)?,
            },
            Step::Shield(call) => match &answer {
                Some(answer) => planner.called(answer.clone())?,
                None => return Ok(Answered::Build(Box::new(call))),
            },
            Step::Done(plan) => return Ok(Answered::Plan(plan)),
        }
    }
}

/// Calls a remote recipe's endpoint. The planner checks the answer as it checks any recipe.
async fn call_remote(chain: &CachedRpc, call: &RemoteCall) -> Result<RemoteAnswer, ServiceError> {
    let failed = |error: reqwest::Error| {
        ServiceError::new(StatusCode::BAD_GATEWAY, "remote", format!("the remote endpoint failed: {error}"))
    };
    let http = reqwest::Client::builder().timeout(remote::CALL_TIMEOUT).build().map_err(failed)?;
    let response = http.post(&call.url).json(&remote::request_body(call)).send().await.map_err(failed)?;
    let status = response.status().as_u16();
    let answer: Value = response.json().await.map_err(failed)?;

    let answer = remote::answered(status, &answer)?;
    let tables = lookup_tables(chain, &answer.lookup_tables()).await?;

    Ok(answer.read(&tables)?)
}

async fn verified(
    chain: &CachedRpc,
    transaction: &sdp_intents_planner::Transaction,
) -> Result<VerifiedTransaction, ServiceError> {
    let mut accounts = AccountMap::default();

    for _ in 0..MAX_VERIFY_ROUNDS {
        match verify_transaction(transaction, &accounts)? {
            VerifyStep::Fetch(addresses) => {
                let fetched = chain.accounts(&addresses, Freshness::Live).await?;
                accounts.insert_fetched(&addresses, fetched);
            }
            VerifyStep::Done(verified) => return Ok(*verified),
        }
    }

    Err(ServiceError::refused(
        "verify",
        format!("the verifier asked for accounts in more than {MAX_VERIFY_ROUNDS} rounds"),
    ))
}

/// The interface and the implementation of each intent, read before the compile, so that the
/// service knows which documents to load.
fn references(request: &Value) -> Result<Vec<IntentReference>, ServiceError> {
    let intents = request
        .get("intents")
        .and_then(Value::as_array)
        .ok_or_else(|| ServiceError::invalid_request("`intents` is a list of intents"))?;

    intents
        .iter()
        .enumerate()
        .map(|(position, intent)| {
            let range = |key: &str| {
                let text = intent.get(key).and_then(Value::as_str).ok_or_else(|| {
                    ServiceError::invalid_request(format!(
                        "intent {position} has no `{key}`, such as `solana.org/token.transfer@^1`"
                    ))
                })?;

                IdRange::parse(text)
                    .map_err(|reason| ServiceError::invalid_request(format!("intent {position}: {reason}")))
            };
            let allow_unapproved = intent.pointer("/options/allowUnapproved").and_then(Value::as_bool).unwrap_or(false);

            Ok(IntentReference {
                interface: range("interface")?,
                implementation: range("implementation")?,
                allow_unapproved,
            })
        })
        .collect()
}

/// The RPC requests that one plan made. The cache's hits and misses count accounts, so only
/// `/metrics` shows them.
pub fn calls_json(calls: sdp_intents_chain::RpcCalls) -> Value {
    json!({
        "getMultipleAccounts": calls.get_multiple_accounts,
        "simulateTransaction": calls.simulate_transaction,
        "getLatestBlockhash": calls.get_latest_blockhash,
        "getBlockHeight": calls.get_block_height,
        "getSignatureStatuses": calls.get_signature_statuses,
    })
}

/// The provider's signatures that a plan of a provider's transaction holds, as `presigned`.
fn presigned(body: &Value) -> Result<Vec<ProviderSignature>, ServiceError> {
    sdp_intents_planner::json::presigned_from_json(body.get("presigned")).map_err(ServiceError::invalid_request)
}
