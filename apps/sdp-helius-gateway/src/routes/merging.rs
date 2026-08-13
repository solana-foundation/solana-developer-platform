//! `POST /v1/wallets/merging`.

use axum::Json;

use crate::error::GatewayError;
use crate::extract::ValidatedJson;
use crate::wire::merging::{MergingRequest, MergingResponse};

/// Builds an unsigned transaction that sets the wallet's merge opt-in.
///
/// Takes no key material — an address and a boolean are both public. The owner must
/// sign the result, which is why this cannot be a key-authority-only operation.
pub async fn handle(
    ValidatedJson(request): ValidatedJson<MergingRequest>,
) -> Result<Json<MergingResponse>, GatewayError> {
    tracing::info!(
        request_id = %request.request_id,
        owner = %request.owner,
        enabled = request.enabled,
        "merging opt-in requested"
    );
    Err(GatewayError::NotImplemented)
}
