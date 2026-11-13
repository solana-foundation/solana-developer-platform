//! The SDP intents service: the planner and the verifier over a cached view of the chain, behind a
//! JSON API. Every document comes from the registry on the chain.
//!
//! | Route | Body | Returns |
//! | :-- | :-- | :-- |
//! | `GET /health` | | `ok` |
//! | `GET /metrics` | | Request, RPC, and cache counters, in the Prometheus text format |
//! | `GET /v1/registry` | | Every organization, interface, and implementation, without documents |
//! | `GET /v1/organizations` | | Every organization |
//! | `GET /v1/interfaces`, `GET /v1/implementations` | | Every index of that kind |
//! | `GET /v1/{kind}/{organization}/{name}` | | One index: its head, versions, and authorities |
//! | `GET /v1/{kind}/{organization}/{name}/versions/{version}` | | One version, with its document as definition JSON |
//! | `GET /v1/interfaces/{organization}/{name}/implementations` | | The implementations of the interface |
//! | `POST /v1/interfaces/{organization}/{name}/versions/{version}/matches` | `{ inputs, payers, all }` | `implementationsFor` |
//! | `POST /v1/prepare` | A plan request (`DESIGN.md`, 4.1) | The plan, and the RPC calls that it made |
//! | `POST /v1/verify` | `{ message, expected }` or `{ transaction, expected }`, of any version | What the message proves to its signer |
//! | `GET /v1/wallets` | | The local wallets, with `--wallets` |
//! | `POST /v1/send` | `{ message }` | Signs with the local wallets and sends, with `--wallets` |
//!
//! With `--wallets`, `POST /v1/prepare` also takes `x-sdp-tamper: 1`, for the playground.

mod describe;
mod error;
mod flows;
mod implementations;
mod metrics;
mod registry;
mod resources;
mod wallets;
pub mod warm;

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;

use sdp_intents_chain::CachedRpc;
use sdp_intents_compiler::{parse_version, Id};
use sdp_intents_spec::wire::DocumentKind;

pub use crate::error::ServiceError;
pub use crate::metrics::Metrics;
use crate::registry::IndexKey;
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
        .route("/v1/organizations", get(organizations))
        .route("/v1/interfaces", get(interfaces))
        .route("/v1/interfaces/{organization}/{name}", get(interface))
        .route("/v1/interfaces/{organization}/{name}/versions/{version}", get(interface_version))
        .route("/v1/interfaces/{organization}/{name}/versions/{version}/matches", post(matches))
        .route("/v1/interfaces/{organization}/{name}/implementations", get(implementations_of))
        .route("/v1/implementations", get(implementations))
        .route("/v1/implementations/{organization}/{name}", get(implementation))
        .route("/v1/implementations/{organization}/{name}/versions/{version}", get(implementation_version))
        .route("/v1/prepare", post(prepare))
        .route("/v1/verify", post(verify))
        .route("/v1/wallets", get(|State(service): Shared| async move { Json(service.wallets.json()) }))
        .route("/v1/send", post(send))
        .with_state(service)
}

async fn registry(State(service): Shared) -> Response {
    observed(&service, "registry", resources::registry(&service.chain)).await
}

async fn organizations(State(service): Shared) -> Response {
    observed(&service, "organizations", resources::organizations(&service.chain)).await
}

async fn interfaces(State(service): Shared) -> Response {
    observed(&service, "interfaces", resources::kind_list(&service.chain, DocumentKind::Interface)).await
}

async fn implementations(State(service): Shared) -> Response {
    observed(&service, "implementations", resources::kind_list(&service.chain, DocumentKind::Implementation)).await
}

async fn interface(State(service): Shared, Path(path): Path<HashMap<String, String>>) -> Response {
    let read = async { resources::index(&service.chain, IndexKey::interface(&path_id(&path)?)).await };

    observed(&service, "interface", read).await
}

async fn implementation(State(service): Shared, Path(path): Path<HashMap<String, String>>) -> Response {
    let read = async { resources::index(&service.chain, IndexKey::implementation(&path_id(&path)?)).await };

    observed(&service, "implementation", read).await
}

async fn interface_version(State(service): Shared, Path(path): Path<HashMap<String, String>>) -> Response {
    let read =
        async { resources::version(&service.chain, IndexKey::interface(&path_id(&path)?), path_version(&path)?).await };

    observed(&service, "interfaceVersion", read).await
}

async fn implementation_version(State(service): Shared, Path(path): Path<HashMap<String, String>>) -> Response {
    let read = async {
        resources::version(&service.chain, IndexKey::implementation(&path_id(&path)?), path_version(&path)?).await
    };

    observed(&service, "implementationVersion", read).await
}

async fn implementations_of(State(service): Shared, Path(path): Path<HashMap<String, String>>) -> Response {
    let read = async { resources::implementations_of(&service.chain, &path_id(&path)?).await };

    observed(&service, "implementationsOf", read).await
}

/// The interface version comes from the path, as an exact range of the body's `interface`.
async fn matches(
    State(service): Shared,
    Path(path): Path<HashMap<String, String>>,
    Json(mut body): Json<Value>,
) -> Response {
    let read = async {
        let interface = format!("{}@{}", path_id(&path)?, path_text(&path, "version")?);
        body.as_object_mut()
            .ok_or_else(|| ServiceError::invalid_request("the body is a JSON object"))?
            .insert("interface".to_owned(), Value::String(interface));

        implementations::implementations_for(&service.chain, &body).await
    };

    observed(&service, "matches", read).await
}

fn path_text<'p>(path: &'p HashMap<String, String>, key: &str) -> Result<&'p str, ServiceError> {
    path.get(key).map(String::as_str).ok_or_else(|| ServiceError::invalid_request(format!("the path has no {key}")))
}

fn path_id(path: &HashMap<String, String>) -> Result<Id, ServiceError> {
    let id = format!("{}/{}", path_text(path, "organization")?, path_text(path, "name")?);

    Id::parse(&id).map_err(ServiceError::invalid_request)
}

fn path_version(path: &HashMap<String, String>) -> Result<sdp_intents_spec::wire::SemverV1, ServiceError> {
    parse_version(path_text(path, "version")?).map_err(ServiceError::invalid_request)
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
