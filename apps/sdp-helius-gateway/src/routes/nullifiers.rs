//! `POST /v1/nullifiers/status`.

use axum::Json;

use crate::error::GatewayError;
use crate::extract::ValidatedJson;
use crate::wire::nullifiers::{NullifierStatusRequest, NullifierStatusResponse};

/// Reports whether each supplied nullifier has been observed spent.
///
/// Takes no key material and mutates nothing, so it is always safe to repeat — which
/// is what makes it usable as the reconciliation probe after a lost response.
///
/// When implemented, the one rule that matters: an indexer failure must surface as
/// `INDEXER_UNAVAILABLE` or `INDEXER_LAG`, **never** as `seen: false`. A false
/// negative causes a retry and a second payment; a false positive only stalls one
/// operation. See the wire module for the full reasoning.
pub async fn handle(
    ValidatedJson(request): ValidatedJson<NullifierStatusRequest>,
) -> Result<Json<NullifierStatusResponse>, GatewayError> {
    tracing::info!(
        request_id = %request.request_id,
        // A count, not the nullifiers themselves: they are not secret, but they are
        // the exactly-once key and there is no reason to scatter them through logs.
        nullifiers = request.nullifiers.len(),
        require_slot = ?request.require_slot,
        "nullifier status requested"
    );
    Err(GatewayError::NotImplemented)
}
