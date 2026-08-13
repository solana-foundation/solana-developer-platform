//! `POST /v1/operations/prove`.

use axum::Json;

use crate::error::GatewayError;
use crate::extract::ValidatedJson;
use crate::wire::prove::{ProveRequest, ProveResponse};

/// Assembles the witness and obtains a proof. The long call.
pub async fn handle(
    ValidatedJson(request): ValidatedJson<ProveRequest>,
) -> Result<Json<ProveResponse>, GatewayError> {
    tracing::info!(
        request_id = %request.preamble.request_id,
        // Zero pinned inputs is the retry-unsafe case: without them a retry can
        // re-select different notes and double-pay. Worth seeing in logs.
        pinned_inputs = request.pinned_inputs.len(),
        "prove requested"
    );
    Err(GatewayError::NotImplemented)
}
