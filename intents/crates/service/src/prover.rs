//! `/v1/intents/prover/*`: the Privacy Rings prover's API, answered by the service's prover, for a
//! caller that does not prove in its own host (`DESIGN.md`, 4.17). The body is a spend's witness,
//! which holds the spent notes and the owner's nullifier secret. It is Restricted data, so the
//! service forwards it and never logs or keeps it. The caller verifies each proof against the
//! pool's verifying key, so a false proof gets nothing signed.

use std::time::{Duration, Instant};

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
    let unavailable = |error: reqwest::Error| {
        ServiceError::new(StatusCode::BAD_GATEWAY, "proverUnavailable", format!("the prover: {error}"))
    };
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
