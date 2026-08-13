//! `POST /v1/wallets/register`.

use axum::Json;

use crate::error::GatewayError;
use crate::extract::ValidatedJson;
use crate::wire::register::{RegisterRequest, RegisterResponse};

/// Builds an unsigned registration transaction.
///
/// Validates the body and stops. The body is parsed rather than ignored so the
/// wire contract is exercised even before the flow behind it exists.
///
/// Takes no key material: a `ShieldedAddress` is built entirely from public halves,
/// so this handler will construct one directly rather than through a
/// `WalletAuthority`.
pub async fn handle(
    ValidatedJson(request): ValidatedJson<RegisterRequest>,
) -> Result<Json<RegisterResponse>, GatewayError> {
    // Safe to log in full: every field on this request is public.
    tracing::info!(
        request_id = %request.request_id,
        owner = %request.owner,
        "register requested"
    );
    Err(GatewayError::NotImplemented)
}
