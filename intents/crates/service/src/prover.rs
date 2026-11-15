//! `/v1/intents/prover/*`: the Privacy Rings prover's API, answered by the service's prover, for a
//! caller that does not prove in its own host (`DESIGN.md`, 4.17). The body is a spend's witness,
//! which holds the spent notes and the owner's nullifier secret. It is Restricted data, so the
//! service forwards it and never logs or keeps it. The caller verifies each proof against the
//! pool's verifying key, so a false proof gets nothing signed.

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

use crate::{ServiceError, Shared};

/// A proof of many notes runs for minutes on a cold key, and the prover caps its own work below this.
const PROVE_TIMEOUT: Duration = Duration::from_secs(600);

/// The service's prover.
pub struct Prover {
    url: String,
    http: reqwest::Client,
}

impl Prover {
    pub fn new(url: &str) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(PROVE_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| format!("the prover client: {error}"))?;

        Ok(Self { url: url.trim_end_matches('/').to_owned(), http })
    }
}

/// Forwards the method, the path under the route, the query, the content type, and the body. Answers
/// the prover's status, content type, `Retry-After`, and body.
pub async fn forward(
    State(service): Shared,
    Path(path): Path<String>,
    uri: Uri,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(prover) = service.prover.as_ref() else {
        return ServiceError::new(StatusCode::NOT_FOUND, "noProver", "the service runs no prover").into_response();
    };
    let query = uri.query().map(|query| format!("?{query}")).unwrap_or_default();
    let mut request = prover.http.request(method, format!("{}/{path}{query}", prover.url)).body(body);

    if let Some(content_type) = headers.get(header::CONTENT_TYPE) {
        request = request.header(header::CONTENT_TYPE, content_type);
    }

    let answer = match request.send().await {
        Ok(answer) => answer,
        Err(error) => {
            return ServiceError::new(StatusCode::BAD_GATEWAY, "proverUnavailable", format!("the prover: {error}"))
                .into_response()
        }
    };
    let status = answer.status();
    let kept: Vec<(header::HeaderName, header::HeaderValue)> = [header::CONTENT_TYPE, header::RETRY_AFTER]
        .into_iter()
        .filter_map(|name| answer.headers().get(&name).cloned().map(|value| (name, value)))
        .collect();

    match answer.bytes().await {
        Ok(bytes) => {
            let mut response = (status, bytes).into_response();
            response.headers_mut().extend(kept);
            response
        }
        Err(error) => ServiceError::new(StatusCode::BAD_GATEWAY, "proverUnavailable", format!("the prover: {error}"))
            .into_response(),
    }
}
