//! Stable, secret-safe API errors.

use axum::Json;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use crate::extract::REQUEST_ID_HEADER;

/// Service error with an optional sanitized correlation ID.
#[derive(Debug)]
pub struct ServiceError {
    kind: ErrorKind,
    request_id: Option<String>,
}

#[derive(Debug)]
enum ErrorKind {
    InvalidRequest,
    PayloadTooLarge,
    Unauthorized,
    AdapterUnavailable(&'static str),
    NotImplemented,
    Internal,
}

impl ServiceError {
    /// Creates a validation failure.
    pub const fn invalid_request() -> Self {
        Self {
            kind: ErrorKind::InvalidRequest,
            request_id: None,
        }
    }

    /// Creates a request-body size failure.
    pub const fn payload_too_large() -> Self {
        Self {
            kind: ErrorKind::PayloadTooLarge,
            request_id: None,
        }
    }

    /// Creates an authentication or authorization failure.
    pub const fn unauthorized() -> Self {
        Self {
            kind: ErrorKind::Unauthorized,
            request_id: None,
        }
    }

    /// Creates a fail-closed missing-adapter failure.
    pub const fn adapter_unavailable(adapter: &'static str) -> Self {
        Self {
            kind: ErrorKind::AdapterUnavailable(adapter),
            request_id: None,
        }
    }

    /// Creates the expected contract-skeleton response.
    pub const fn not_implemented() -> Self {
        Self {
            kind: ErrorKind::NotImplemented,
            request_id: None,
        }
    }

    /// Creates an internal failure without exposing its cause.
    pub const fn internal() -> Self {
        Self {
            kind: ErrorKind::Internal,
            request_id: None,
        }
    }

    /// Associates a sanitized request ID with this error.
    pub fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = Some(request_id.into());
        self
    }

    /// Stable machine-readable code.
    pub const fn code(&self) -> &'static str {
        match self.kind {
            ErrorKind::InvalidRequest => "INVALID_REQUEST",
            ErrorKind::PayloadTooLarge => "PAYLOAD_TOO_LARGE",
            ErrorKind::Unauthorized => "UNAUTHORIZED",
            ErrorKind::AdapterUnavailable(_) => "ADAPTER_UNAVAILABLE",
            ErrorKind::NotImplemented => "NOT_IMPLEMENTED",
            ErrorKind::Internal => "INTERNAL",
        }
    }

    const fn status(&self) -> StatusCode {
        match self.kind {
            ErrorKind::InvalidRequest => StatusCode::BAD_REQUEST,
            ErrorKind::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            ErrorKind::Unauthorized => StatusCode::UNAUTHORIZED,
            ErrorKind::AdapterUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            ErrorKind::NotImplemented => StatusCode::NOT_IMPLEMENTED,
            ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    const fn retryable(&self) -> bool {
        matches!(
            self.kind,
            ErrorKind::AdapterUnavailable(_) | ErrorKind::Internal
        )
    }

    fn message(&self) -> String {
        match self.kind {
            ErrorKind::InvalidRequest => "request validation failed".to_owned(),
            ErrorKind::PayloadTooLarge => "request body exceeded the size limit".to_owned(),
            ErrorKind::Unauthorized => "request is not authorized".to_owned(),
            ErrorKind::AdapterUnavailable(adapter) => {
                format!("required adapter is not configured: {adapter}")
            }
            ErrorKind::NotImplemented => {
                "contract is defined but the production adapter is not implemented".to_owned()
            }
            ErrorKind::Internal => "internal service error".to_owned(),
        }
    }
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl std::error::Error for ServiceError {}

impl IntoResponse for ServiceError {
    fn into_response(self) -> Response {
        let status = self.status();
        let code = self.code();
        let message = self.message();
        let retryable = self.retryable();
        let request_id = self.request_id.unwrap_or_else(|| "unset".to_owned());
        let body = ErrorBody {
            code,
            message,
            request_id: request_id.clone(),
            retryable,
        };
        let mut response = (status, Json(body)).into_response();
        if let Ok(header) = HeaderValue::from_str(&request_id) {
            response.headers_mut().insert(REQUEST_ID_HEADER, header);
        }
        response
    }
}

/// Stable JSON error envelope.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    /// Stable machine-readable code.
    pub code: &'static str,
    /// Secret-safe human-readable description.
    pub message: String,
    /// Sanitized correlation ID.
    pub request_id: String,
    /// Whether retrying unchanged may succeed.
    pub retryable: bool,
}
