//! Router assembly.
//!
//! Only `/health` is routed so far. The signed flow endpoints, their per-route
//! timeout budgets and the HMAC middleware land on top of this.

use axum::Router;
use axum::routing::get;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;

use crate::config::MAX_BODY_BYTES;
use crate::state::AppState;

pub mod health;

/// Builds the application router.
///
/// `/health` is unauthenticated on purpose, and will stay outside the signed router
/// when that arrives: a liveness probe carries no shared secret, and requiring one
/// would make an HMAC misconfiguration look like a dead container instead of failing
/// requests with a clear cause.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health::handle))
        // Signed bodies will have to be buffered whole to verify their HMAC, so this
        // bound is load bearing rather than hygiene — it is what caps memory per
        // in-flight request. Applied from the start so no route is ever unbounded.
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES))
        // Records method, path, status and latency. It must never be configured to
        // capture bodies or headers: request bodies will carry viewing and nullifier
        // keys, and `x-hmac-signature` is a credential.
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
