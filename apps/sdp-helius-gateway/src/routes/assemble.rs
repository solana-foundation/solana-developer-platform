//! `POST /v1/transactions/assemble`.

use axum::Json;

use crate::error::GatewayError;
use crate::extract::ValidatedJson;
use crate::wire::assemble::{AssembleRequest, AssembleResponse};

/// Turns a proved payload plus a fresh blockhash into an unsigned transaction.
///
/// Takes no key material, so it is pure and freely retryable.
pub async fn handle(
    ValidatedJson(request): ValidatedJson<AssembleRequest>,
) -> Result<Json<AssembleResponse>, GatewayError> {
    tracing::info!(request_id = %request.request_id, "assemble requested");
    Err(GatewayError::NotImplemented)
}
