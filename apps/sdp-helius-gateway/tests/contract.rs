// `clippy.toml`'s `allow-unwrap-in-tests` only covers `#[cfg(test)]` modules, not
// integration-test crates like this one, so the allowance has to be repeated here.
// Same reasoning as there: in a test a panic IS the failure report.
#![allow(clippy::expect_used, clippy::unwrap_used)]

//! Contract tests against the real router.
//!
//! These drive `routes::app` through `oneshot`, so routing, middleware ordering and
//! the response body are all exercised as deployed rather than by calling handlers
//! directly.
//!
//! Preflight is not involved: `AppState` is built with `protocol_config: None`,
//! which is also the shape a real cold start takes when RPC is briefly unreachable.

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use sdp_helius_gateway::config::Config;
use sdp_helius_gateway::redact::SecretBytes;
use sdp_helius_gateway::routes;
use sdp_helius_gateway::state::AppState;
use serde_json::Value;
use tower::ServiceExt as _;

/// The `sdp-api` caller's secret, for the keyless routes.
const SECRET: &str = "contract-test-secret-of-at-least-32-bytes";
/// The `rings-key-auth` caller's secret, for the key-bearing routes. Deliberately
/// different from [`SECRET`], so a test signing with the wrong one fails.
const KEY_AUTH_SECRET: &str = "contract-test-key-auth-secret-at-least-32";

fn app() -> Router {
    let config = Config {
        port: 0,
        hmac_secret_sdp_api: SecretBytes::from_bytes(SECRET.as_bytes().to_vec()),
        hmac_secret_key_auth: SecretBytes::from_bytes(KEY_AUTH_SECRET.as_bytes().to_vec()),
        solana_rpc_url: "https://api.devnet.solana.com".to_owned(),
        photon_url: "https://photon.invalid".to_owned(),
        prover_url: "https://prover.invalid".to_owned(),
        shielded_pool_program_id: sdp_helius_gateway::config::DEFAULT_SHIELDED_POOL_PROGRAM_ID
            .to_owned(),
    };
    routes::app(AppState::new(config, None))
}

async fn send(request: Request<Body>) -> (StatusCode, Value) {
    let response = app().oneshot(request).await.expect("router responds");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("body readable");
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

#[tokio::test]
async fn health_is_unauthenticated_and_reports_skew_fields() {
    let request = Request::builder()
        .uri("/health")
        .body(Body::empty())
        .expect("valid request");
    let (status, body) = send(request).await;

    assert_eq!(status, StatusCode::OK, "liveness must not require a secret");
    assert_eq!(body["status"], "ok");

    // The skew fields are the reason /health carries a payload at all: a pinned
    // git rev gives no version signal, so the rev must be observable.
    assert_eq!(body["zolanaRev"].as_str().map(str::len), Some(40));
    assert_eq!(
        body["expectedPrograms"]["shieldedPool"],
        sdp_helius_gateway::config::DEFAULT_SHIELDED_POOL_PROGRAM_ID
    );
    assert!(
        body["protocolConfig"].is_null(),
        "no preflight in this state"
    );
}
