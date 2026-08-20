//! `POST /v1/operations/plan`.

use axum::Json;

use crate::error::GatewayError;
use crate::extract::ValidatedJson;
use crate::wire::plan::{PlanRequest, PlanResponse};

/// Selects inputs and describes the operation, without proving.
pub async fn handle(
    ValidatedJson(request): ValidatedJson<PlanRequest>,
) -> Result<Json<PlanResponse>, GatewayError> {
    tracing::info!(
        request_id = %request.preamble.request_id,
        fee_payer = %request.fee_payer,
        "plan requested"
    );
    Err(GatewayError::NotImplemented)
}
