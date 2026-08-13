//! `POST /v1/wallets/sync`.

use axum::Json;

use crate::error::GatewayError;
use crate::extract::ValidatedJson;
use crate::wire::sync::{SyncRequest, SyncResponse};

/// Scans the indexer and reports private state.
pub async fn handle(
    ValidatedJson(request): ValidatedJson<SyncRequest>,
) -> Result<Json<SyncResponse>, GatewayError> {
    tracing::info!(
        request_id = %request.preamble.request_id,
        // Safe and useful: tells us whether a resume was attempted or the
        // request will hit the tag-window horizon on a full rescan.
        resuming = request.preamble.wallet_projection.is_some(),
        require_slot = ?request.preamble.require_slot,
        "sync requested"
    );
    Err(GatewayError::NotImplemented)
}
