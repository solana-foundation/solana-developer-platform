//! Each refusal as JSON: `{ "error": { "code", "message", "details" } }`. The code is stable, and
//! the message is for people.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use sdp_intents_chain::ChainError;
use sdp_intents_client::ClientError;
use sdp_intents_compiler::diagnostic::Report;
use sdp_intents_planner::{PlanError, VerifyError};

#[derive(Debug)]
pub struct ServiceError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub details: Value,
}

impl ServiceError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into(), details: Value::Null }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalidRequest", message)
    }

    /// The request names something that the registry refuses, such as a removed version.
    pub fn refused(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, code, message)
    }

    pub fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    /// Each finding of the compiler, rendered against the request.
    pub fn compile(report: &Report, text: &str) -> Self {
        let findings: Vec<Value> = report
            .diagnostics
            .iter()
            .map(|finding| json!({ "pointer": finding.pointer, "message": finding.message, "help": finding.help }))
            .collect();

        Self {
            details: json!({ "findings": findings, "rendered": report.render("request", text) }),
            ..Self::refused("invalidIntent", "the request does not compile against the registry's documents")
        }
    }
}

impl From<ChainError> for ServiceError {
    fn from(error: ChainError) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "rpc", error.to_string())
    }
}

/// A failed simulation also gives the program logs, which name the instruction and the reason.
impl From<PlanError> for ServiceError {
    fn from(error: PlanError) -> Self {
        let details = match &error {
            PlanError::Simulation { logs, .. } => json!({ "logs": logs }),
            _ => Value::Null,
        };

        Self { details, ..Self::refused("plan", error.to_string()) }
    }
}

impl From<VerifyError> for ServiceError {
    fn from(error: VerifyError) -> Self {
        Self::refused("verify", error.to_string())
    }
}

impl From<ClientError> for ServiceError {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::Plan(error) => error.into(),
            ClientError::Verify(error) => error.into(),
            ClientError::Rpc(error) => Self::new(StatusCode::BAD_GATEWAY, "rpc", error.to_string()),
            ClientError::Decode(message) | ClientError::Compile(message) => Self::invalid_request(message),
            ClientError::MissingSigner(address) => {
                Self::refused("missingSigner", format!("no local wallet holds the key of {address}"))
            }
        }
    }
}

impl From<serde_json::Error> for ServiceError {
    fn from(error: serde_json::Error) -> Self {
        Self::invalid_request(format!("the body is not JSON: {error}"))
    }
}

impl IntoResponse for ServiceError {
    fn into_response(self) -> Response {
        let body = json!({ "error": { "code": self.code, "message": self.message, "details": self.details } });

        (self.status, Json(body)).into_response()
    }
}
