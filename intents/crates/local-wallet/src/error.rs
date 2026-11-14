//! Each refusal as JSON, in the service's shape: `{ "error": { "code", "message" } }`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub struct WalletError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl WalletError {
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, code: "invalidRequest", message: message.into() }
    }

    /// The wallet will not do what the request asks, such as sign a spend that it cannot check.
    pub fn refused(code: &'static str, message: impl Into<String>) -> Self {
        Self { status: StatusCode::UNPROCESSABLE_ENTITY, code, message: message.into() }
    }

    pub fn failed(code: &'static str, message: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_GATEWAY, code, message: message.into() }
    }
}

impl IntoResponse for WalletError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": { "code": self.code, "message": self.message, "details": null } })))
            .into_response()
    }
}

impl From<sdp_intents_client::ClientError> for WalletError {
    fn from(error: sdp_intents_client::ClientError) -> Self {
        Self::failed("client", error.to_string())
    }
}

impl From<sdp_intents_client::MessageError> for WalletError {
    fn from(error: sdp_intents_client::MessageError) -> Self {
        Self::invalid_request(error.to_string())
    }
}

impl From<sdp_intents_privacy_rings::ShieldedError> for WalletError {
    fn from(error: sdp_intents_privacy_rings::ShieldedError) -> Self {
        Self::failed("privacyRings", format!("Privacy Rings failed: {error}"))
    }
}
