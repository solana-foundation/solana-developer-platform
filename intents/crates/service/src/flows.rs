//! `prepare` and `verify`: the planner and the verifier, answered from the cache.

use base64::Engine as _;
use serde_json::{json, Value};

use sdp_intents_chain::{CachedRpc, Freshness};
use sdp_intents_client::{decode_message, fresh_address, json as plan_json, prepared};
use sdp_intents_compiler::IdRange;
use sdp_intents_planner::{
    verify_transaction, AccountMap, IntentDocuments, Payers, Plan, PlanRequest, Planner, Step, VerifiedTransaction,
    VerifyStep,
};

use crate::error::ServiceError;
use crate::registry::{catalog, IntentReference, Registry};

/// Each `verify_intent` needs its two version accounts, then the accounts that its recipe and its
/// message read. A plan of many intents asks for each kind in one call.
const MAX_VERIFY_ROUNDS: usize = 8;

/// A plan request as `DESIGN.md`, section 4.1, writes it. The documents come from the registry.
/// With `tamper`, the transaction differs from the plan, as `tamper` says.
pub async fn prepare(chain: &CachedRpc, text: &str, tamper: bool) -> Result<Value, ServiceError> {
    let request: Value = serde_json::from_str(text)?;
    let references = references(&request)?;
    let documents = Registry { chain }.intent_documents(&references).await?;

    let catalog = catalog(documents.iter().flat_map(|intent| [&intent.interface, &intent.implementation]))?;
    let compiled = catalog.compile_plan(text).map_err(|report| ServiceError::compile(&report, text))?;
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
    };

    let mut plan = plan(chain, &plan_request).await?;

    if tamper {
        tamper_with(&mut plan);
    }

    let blockhash = chain.latest_blockhash().await?;

    Ok(plan_json::plan(&prepared(plan, blockhash)?, request))
}

/// A body of `{ "message": base64, "expected": text }`. `expected` is the plan's message, when the
/// caller has one.
pub async fn verify(chain: &CachedRpc, body: &Value) -> Result<Value, ServiceError> {
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| ServiceError::invalid_request("`message` is the base64 of a v1 message"))?;
    let message = base64::engine::general_purpose::STANDARD
        .decode(message)
        .map_err(|error| ServiceError::invalid_request(format!("`message` is not base64: {error}")))?;
    let verified = verified(chain, &message).await?;

    Ok(plan_json::verified(&verified, body.get("expected").and_then(Value::as_str)))
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

async fn plan(chain: &CachedRpc, request: &PlanRequest<'_>) -> Result<Plan, ServiceError> {
    let mut planner = Planner::new(request, fresh_address())?;
    let mut accounts = AccountMap::default();

    loop {
        match planner.next(&accounts)? {
            Step::Fetch(addresses) => {
                let fetched = chain.accounts(&addresses, Freshness::Live).await?;
                accounts.insert_fetched(&addresses, fetched);
            }
            Step::Simulate(simulation) => planner.simulated(chain.simulate(&simulation).await?)?,
            Step::Done(plan) => return Ok(*plan),
        }
    }
}

async fn verified(chain: &CachedRpc, message: &[u8]) -> Result<VerifiedTransaction, ServiceError> {
    let transaction = decode_message(message)?;
    let mut accounts = AccountMap::default();

    for _ in 0..MAX_VERIFY_ROUNDS {
        match verify_transaction(&transaction, &accounts)? {
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

/// The RPC calls that one request made, as the metrics count them. Requests that run at once share
/// the counters, so the numbers are exact only for one request at a time.
pub fn calls_json(before: sdp_intents_chain::RpcCalls, after: sdp_intents_chain::RpcCalls) -> Value {
    json!({
        "getMultipleAccounts": after.get_multiple_accounts.saturating_sub(before.get_multiple_accounts),
        "simulateTransaction": after.simulate_transaction.saturating_sub(before.simulate_transaction),
        "getLatestBlockhash": after.get_latest_blockhash.saturating_sub(before.get_latest_blockhash),
        "cacheHits": after.cache_hits.saturating_sub(before.cache_hits),
        "cacheMisses": after.cache_misses.saturating_sub(before.cache_misses),
    })
}
