//! `/v1/intents/prover/*`: the Privacy Rings prover's API, answered by the service's prover, for a
//! caller that does not prove in its own host (`DESIGN.md`, 4.17). The body is a spend's witness,
//! which holds the spent notes and the owner's nullifier secret. It is Restricted data, so the
//! service forwards it and never logs or keeps it. The caller verifies each proof against the
//! pool's verifying key, so a false proof gets nothing signed.

use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use tokio::sync::Semaphore;

use crate::{ServiceError, Shared};

/// A proof of many notes runs for minutes on a cold key, and the prover caps its own work below this.
const PROVE_TIMEOUT: Duration = Duration::from_secs(600);

/// Proving uses every core of the prover, so more calls at once only queue there and hold memory.
const CONCURRENT_PROOFS: usize = 4;

/// The route refuses a larger body. It equals axum's default, which the e2e's service-proved spend
/// fits under.
pub const BODY_LIMIT: usize = 2 * 1024 * 1024;

/// The service's prover.
pub struct Prover {
    url: String,
    http: reqwest::Client,
    permits: Semaphore,
}

impl Prover {
    pub fn new(url: &str) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(PROVE_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| format!("the prover client: {error}"))?;

        Ok(Self { url: url.trim_end_matches('/').to_owned(), http, permits: Semaphore::new(CONCURRENT_PROOFS) })
    }
}

/// What the caller sent, to forward as it is.
pub struct Forwarded {
    path: String,
    query: Option<String>,
    method: Method,
    content_type: Option<header::HeaderValue>,
    body: Bytes,
}

/// Forwards the method, the path under the route, the query, the content type, and the body.
/// Answers the prover's status, content type, `Retry-After`, and body. Counts each call as the
/// route `prover`, by the prover's status class.
pub async fn forward(
    State(service): Shared,
    Path(path): Path<String>,
    uri: Uri,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let started = Instant::now();
    let forwarded = Forwarded {
        path,
        query: uri.query().map(str::to_owned),
        method,
        content_type: headers.get(header::CONTENT_TYPE).cloned(),
        body,
    };
    let relayed = relay(service.prover.as_ref(), forwarded).await;
    let outcome = match &relayed {
        Ok(response) if response.status().is_success() => "ok",
        Ok(_) => "proverRefused",
        Err(error) => error.code,
    };
    service.metrics.observe("prover", outcome, started.elapsed());

    relayed.unwrap_or_else(IntoResponse::into_response)
}

async fn relay(prover: Option<&Prover>, forwarded: Forwarded) -> Result<Response, ServiceError> {
    let prover =
        prover.ok_or_else(|| ServiceError::new(StatusCode::NOT_FOUND, "noProver", "the service runs no prover"))?;
    let Ok(_permit) = prover.permits.try_acquire() else {
        return Ok(busy());
    };
    let unavailable =
        |error: reqwest::Error| ServiceError::new(StatusCode::BAD_GATEWAY, "proverUnavailable", failure(&error));
    let query = forwarded.query.map(|query| format!("?{query}")).unwrap_or_default();
    let mut request =
        prover.http.request(forwarded.method, format!("{}/{}{query}", prover.url, forwarded.path)).body(forwarded.body);

    if let Some(content_type) = forwarded.content_type {
        request = request.header(header::CONTENT_TYPE, content_type);
    }

    let answer = request.send().await.map_err(unavailable)?;
    let status = answer.status();
    let kept: Vec<(header::HeaderName, header::HeaderValue)> = [header::CONTENT_TYPE, header::RETRY_AFTER]
        .into_iter()
        .filter_map(|name| answer.headers().get(&name).cloned().map(|value| (name, value)))
        .collect();
    let bytes = answer.bytes().await.map_err(unavailable)?;

    let mut response = (status, bytes).into_response();
    response.headers_mut().extend(kept);

    Ok(response)
}

/// Every permit is in use. The caller retries, or proves in its own host.
fn busy() -> Response {
    let mut response =
        ServiceError::new(StatusCode::SERVICE_UNAVAILABLE, "proverBusy", "the prover is busy").into_response();
    response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("5"));

    response
}

/// What failed, without the prover's address.
fn failure(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "the prover timed out"
    } else if error.is_connect() {
        "the prover is unreachable"
    } else {
        "the prover failed"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_busy_prover_answers_503_with_a_retry_time() {
        let prover = Prover::new("http://127.0.0.1:9").unwrap();
        let _all = prover.permits.try_acquire_many(u32::try_from(CONCURRENT_PROOFS).unwrap()).unwrap();
        let forwarded = Forwarded {
            path: "prove".to_owned(),
            query: None,
            method: Method::POST,
            content_type: None,
            body: Bytes::new(),
        };

        let response = relay(Some(&prover), forwarded).await.unwrap();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers().get(header::RETRY_AFTER), Some(&HeaderValue::from_static("5")));
    }
}
