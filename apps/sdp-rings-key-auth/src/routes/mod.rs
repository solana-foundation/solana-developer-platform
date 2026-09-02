//! HTTP router.

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use tower_http::trace::TraceLayer;

use crate::config::MAX_BODY_BYTES;
use crate::state::AppState;

pub mod health;
pub mod stubs;

/// Builds the application router.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health::handle))
        .route("/v1/wallets", post(stubs::create_wallet))
        .route("/v1/wallets/{wallet_id}/rotate", post(stubs::rotate_wallet))
        .route("/v1/wallets/sync", post(stubs::sync_wallet))
        .route("/v1/operations/plan", post(stubs::plan_operation))
        .route("/v1/operations/prove", post(stubs::prove_operation))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
