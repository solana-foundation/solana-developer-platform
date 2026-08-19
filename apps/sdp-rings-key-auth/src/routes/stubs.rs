//! Authenticated contract-only operation handlers.

use axum::Json;
use axum::extract::Path;

use crate::error::ServiceError;
use crate::extract::AuthorizedJson;
use crate::wire::api::{
    CreateWalletRequest, CreateWalletResponse, PlanRequest, ProveRequest, RotateWalletRequest,
    RotateWalletResponse, SyncRequest,
};
use crate::wire::gateway::{GatewayPlanResponse, GatewayProveResponse, GatewaySyncResponse};

/// Provisioning contract stub.
pub async fn create_wallet(
    AuthorizedJson(request): AuthorizedJson<CreateWalletRequest>,
) -> Result<Json<CreateWalletResponse>, ServiceError> {
    Err(not_implemented(&request.envelope.request_id))
}

/// Viewing-key rotation contract stub.
pub async fn rotate_wallet(
    Path(wallet_id): Path<String>,
    AuthorizedJson(request): AuthorizedJson<RotateWalletRequest>,
) -> Result<Json<RotateWalletResponse>, ServiceError> {
    if wallet_id != request.envelope.wallet_id {
        return Err(ServiceError::invalid_request().with_request_id(request.envelope.request_id));
    }
    Err(not_implemented(&request.envelope.request_id))
}

/// Wallet synchronization contract stub.
pub async fn sync_wallet(
    AuthorizedJson(request): AuthorizedJson<SyncRequest>,
) -> Result<Json<GatewaySyncResponse>, ServiceError> {
    Err(not_implemented(&request.envelope.request_id))
}

/// Operation planning contract stub.
pub async fn plan_operation(
    AuthorizedJson(request): AuthorizedJson<PlanRequest>,
) -> Result<Json<GatewayPlanResponse>, ServiceError> {
    Err(not_implemented(&request.envelope.request_id))
}

/// Operation proving contract stub.
pub async fn prove_operation(
    AuthorizedJson(request): AuthorizedJson<ProveRequest>,
) -> Result<Json<GatewayProveResponse>, ServiceError> {
    Err(not_implemented(&request.envelope.request_id))
}

fn not_implemented(request_id: &str) -> ServiceError {
    ServiceError::not_implemented().with_request_id(request_id)
}
