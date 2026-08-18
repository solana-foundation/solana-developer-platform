//! `GET /health`.

use axum::Json;
use axum::extract::State;

use crate::state::AppState;
use crate::wire::health::{AdapterReadinessResponse, HealthResponse};

/// Reports process liveness and production-adapter readiness.
pub async fn handle(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        ready: state.adapters.all_ready(),
        adapters: AdapterReadinessResponse {
            stage_authorizer: state.adapters.stage_authorizer,
            key_store: state.adapters.key_store,
            envelope_cipher: state.adapters.envelope_cipher,
            gateway_client: state.adapters.gateway_client,
        },
    })
}
