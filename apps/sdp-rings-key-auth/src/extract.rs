//! Request extraction helpers.

use axum::extract::{FromRequest, Request};
use axum::http::HeaderMap;
use axum::{Json, RequestExt as _};
use serde::de::DeserializeOwned;

use crate::error::ServiceError;
use crate::ports::StageToken;
use crate::state::AppState;
use crate::validate::StageRequest;

/// Header shared with SDP for correlation.
pub const REQUEST_ID_HEADER: &str = "x-request-id";
/// Header carrying an opaque SDP-issued stage capability.
pub const AUTHORIZATION_HEADER: &str = "authorization";

/// Returns a bounded log-safe correlation ID.
pub fn correlation_id(headers: &HeaderMap) -> String {
    headers
        .get(REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(sanitize_request_id)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unset".to_owned())
}

/// JSON body that has passed structural validation and stage authorization.
pub struct AuthorizedJson<T>(pub T);

impl<T> FromRequest<AppState> for AuthorizedJson<T>
where
    T: DeserializeOwned + StageRequest + Send + 'static,
{
    type Rejection = ServiceError;

    async fn from_request(request: Request, state: &AppState) -> Result<Self, Self::Rejection> {
        let had_header_request_id = request.headers().contains_key(REQUEST_ID_HEADER);
        let header_request_id = correlation_id(request.headers());
        let token = bearer_token(request.headers())
            .and_then(StageToken::new)
            .map_err(|error| error.with_request_id(header_request_id.clone()))?;

        let value = match request.extract::<Json<T>, _>().await {
            Ok(Json(value)) => value,
            Err(rejection) => {
                tracing::warn!(
                    request_id = %header_request_id,
                    status = %rejection.status(),
                    "request body failed extraction"
                );
                let error = if rejection.status() == axum::http::StatusCode::PAYLOAD_TOO_LARGE {
                    ServiceError::payload_too_large()
                } else {
                    ServiceError::invalid_request()
                };
                return Err(error.with_request_id(header_request_id));
            }
        };

        let envelope_request_id = &value.envelope().request_id;
        let request_id = if had_header_request_id {
            header_request_id
        } else {
            let sanitized = sanitize_request_id(envelope_request_id);
            if sanitized.is_empty() {
                "unset".to_owned()
            } else {
                sanitized
            }
        };
        if had_header_request_id && request_id != *envelope_request_id {
            return Err(ServiceError::invalid_request().with_request_id(request_id));
        }

        value
            .validate()
            .map_err(|error| error.with_request_id(request_id.clone()))?;
        state
            .authorizer()
            .authorize(&token, value.envelope())
            .await
            .map_err(|error| error.with_request_id(request_id))?;

        Ok(Self(value))
    }
}

fn bearer_token(headers: &HeaderMap) -> Result<String, ServiceError> {
    let value = headers
        .get(AUTHORIZATION_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(ServiceError::unauthorized)?;
    let token = value
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty())
        .ok_or_else(ServiceError::unauthorized)?;
    Ok(token.to_owned())
}

fn sanitize_request_id(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
        .take(128)
        .collect()
}
