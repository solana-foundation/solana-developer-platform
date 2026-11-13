//! The SDP intents service: the planner and the verifier over a cached view of the chain, behind a
//! JSON API. Every document comes from the registry on the chain.
//!
//! | Route | Body | Returns |
//! | :-- | :-- | :-- |
//! | `GET /health` | | `ok` |
//! | `GET /metrics` | | Request, RPC, and cache counters, in the Prometheus text format |
//! | `GET /v1/registry` | | Every organization, interface, and implementation |
//! | `POST /v1/prepare` | A plan request (`DESIGN.md`, 4.1) | The plan, and the RPC calls that it made |
//! | `POST /v1/verify` | `{ message, expected }` or `{ transaction, expected }`, of any version | What the message proves to its signer |
//! | `POST /v1/implementations` | `{ interface, inputs, payers, all }` | `implementationsFor` |
//! | `GET /v1/wallets` | | The local wallets, with `--wallets` |
//! | `POST /v1/send` | `{ message }` | Signs with the local wallets and sends, with `--wallets` |
//!
//! With `--wallets`, `POST /v1/prepare` also takes `x-sdp-tamper: 1`, for the playground.

mod describe;
mod error;
mod flows;
mod implementations;
mod listing;
mod metrics;
mod registry;
mod wallets;
pub mod warm;

use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;

use sdp_intents_chain::CachedRpc;

pub use crate::error::ServiceError;
pub use crate::metrics::Metrics;
pub use crate::wallets::Wallets;

pub struct Service {
    pub chain: CachedRpc,
    pub wallets: Wallets,
    pub metrics: Metrics,
}

type Shared = State<Arc<Service>>;

pub fn router(service: Arc<Service>) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/metrics", get(|State(service): Shared| async move { service.metrics.render(service.chain.calls()) }))
        .route("/v1/registry", get(registry))
        .route("/v1/prepare", post(prepare))
        .route("/v1/verify", post(verify))
        .route("/v1/implementations", post(implementations))
        .route("/v1/wallets", get(|State(service): Shared| async move { Json(service.wallets.json()) }))
        .route("/v1/send", post(send))
        .with_state(service)
}

async fn registry(State(service): Shared) -> Response {
    observed(&service, "registry", listing::listing(&service.chain)).await
}

/// `x-sdp-tamper: 1` asks for a transaction that `verify_intent` refuses. Only a service with local
/// wallets honors it, because only the playground needs it.
async fn prepare(State(service): Shared, headers: HeaderMap, body: String) -> Response {
    let tamper = !service.wallets.is_empty() && headers.get("x-sdp-tamper").is_some_and(|value| value == "1");
    let counted = sdp_intents_chain::counted(flows::prepare(&service.chain, &body, tamper)).await;
    let prepared = counted.output.map(|mut plan| {
        if let Some(plan) = plan.as_object_mut() {
            plan.insert("rpcCalls".to_owned(), flows::calls_json(counted.calls));
        }

        plan
    });

    observed(&service, "prepare", async { prepared }).await
}

async fn verify(State(service): Shared, Json(body): Json<Value>) -> Response {
    observed(&service, "verify", flows::verify(&service.chain, &body)).await
}

async fn implementations(State(service): Shared, Json(body): Json<Value>) -> Response {
    observed(&service, "implementations", implementations::implementations_for(&service.chain, &body)).await
}

async fn send(State(service): Shared, Json(body): Json<Value>) -> Response {
    observed(&service, "send", service.wallets.send(&service.chain, &body)).await
}

/// Runs one route, and counts it by its outcome.
async fn observed(
    service: &Service,
    route: &'static str,
    run: impl Future<Output = Result<Value, ServiceError>>,
) -> Response {
    let started = Instant::now();
    let result = run.await;
    let outcome = result.as_ref().map_or_else(|error| error.code, |_| "ok");
    service.metrics.observe(route, outcome, started.elapsed());

    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}
