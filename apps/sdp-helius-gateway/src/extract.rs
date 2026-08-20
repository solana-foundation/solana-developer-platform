//! A JSON extractor that fails with the gateway's own error shape.
//!
//! axum's built-in `Json` rejection produces its own status and body. That would
//! leave two error contracts on the wire, and SDP switches on `code` — so every
//! failure, including a malformed body, has to come back as an [`ErrorBody`].
//!
//! It is also where [`Validate`] runs. Deserialization cannot express key widths or
//! index ordering, and those now arrive from another service across a language
//! boundary, so they are checked here rather than deep inside a handler. Both failure
//! kinds share one error path on purpose — see [`crate::validate`].
//!
//! [`ErrorBody`]: crate::error::ErrorBody

use axum::extract::{FromRequest, Request};
use axum::http::HeaderMap;
use axum::{Json, RequestExt};
use serde::de::DeserializeOwned;

use crate::error::GatewayError;
use crate::validate::Validate;

/// Header SDP already uses for correlation
/// (`apps/sdp-api/src/middleware/request-id.ts`).
pub const REQUEST_ID_HEADER: &str = "x-request-id";

/// Deserializes a JSON body, reporting failures as [`GatewayError::InvalidRequest`].
pub struct ValidatedJson<T>(pub T);

impl<S, T> FromRequest<S> for ValidatedJson<T>
where
    // `Validate` is part of the bound rather than something a handler remembers to
    // call. Every request type implements it, so a new one cannot be routed without
    // deciding what its validation is.
    T: DeserializeOwned + Validate + 'static,
    S: Send + Sync,
{
    type Rejection = GatewayError;

    async fn from_request(request: Request, _state: &S) -> Result<Self, Self::Rejection> {
        // Captured before consuming the request, so an unparseable body is still
        // correlatable. A malformed body is what makes the `requestId` inside it
        // unreachable.
        let correlation = correlation_id(request.headers());

        match request.extract::<Json<T>, _>().await {
            Ok(Json(value)) => {
                // Structural checks that the type system and serde cannot express.
                // Its errors are authored here, so unlike the serde detail below they
                // are safe to return verbatim — they name a field and a length.
                value.validate()?;
                Ok(Self(value))
            }
            Err(rejection) => {
                // Full detail goes to the log, never to the response. serde's
                // messages can quote the offending value, and these bodies carry
                // viewing and nullifier keys — a wrong-typed `nullifierKey` would
                // otherwise be echoed straight back.
                tracing::warn!(
                    request_id = %correlation,
                    detail = %rejection.body_text(),
                    "request body failed validation"
                );
                Err(GatewayError::InvalidRequest(format!(
                    "body failed validation; see gateway logs for x-request-id {correlation}"
                )))
            }
        }
    }
}

fn correlation_id(headers: &HeaderMap) -> String {
    headers
        .get(REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        // Same character class and cap as SDP's own request-id middleware, so a
        // hostile header cannot inject newlines into our logs.
        .map(|value| {
            value
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
                .take(128)
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unset".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn strips_control_characters_and_caps_length() {
        let mut headers = HeaderMap::new();
        headers.insert(
            REQUEST_ID_HEADER,
            HeaderValue::from_static("op_01J:attempt-3.a"),
        );
        assert_eq!(correlation_id(&headers), "op_01J:attempt-3.a");

        let mut long = HeaderMap::new();
        long.insert(
            REQUEST_ID_HEADER,
            HeaderValue::from_str(&"a".repeat(500)).unwrap(),
        );
        assert_eq!(correlation_id(&long).len(), 128);
    }

    #[test]
    fn falls_back_when_absent() {
        assert_eq!(correlation_id(&HeaderMap::new()), "unset");
    }
}
