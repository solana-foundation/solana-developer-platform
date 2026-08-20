//! `POST /v1/operations/shield`.

use axum::Json;

use crate::error::GatewayError;
use crate::extract::ValidatedJson;
use crate::wire::shield::{ShieldRequest, ShieldResponse};

/// Builds an unsigned deposit transaction in a single call.
///
/// Takes no key material: the shielded address is resolved from the on-chain user
/// registry, so like assemble this handler never sees a secret.
pub async fn handle(
    ValidatedJson(request): ValidatedJson<ShieldRequest>,
) -> Result<Json<ShieldResponse>, GatewayError> {
    tracing::info!(request_id = %request.request_id, "shield requested");
    Err(GatewayError::NotImplemented)
}
