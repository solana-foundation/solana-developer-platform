// `clippy.toml`'s `allow-unwrap-in-tests` only covers `#[cfg(test)]` modules, not
// integration-test crates like this one, so the allowance has to be repeated here.
// Same reasoning as there: in a test a panic IS the failure report.
#![allow(clippy::expect_used, clippy::unwrap_used)]

//! Contract tests against the real router.
//!
//! These drive `routes::app` through `oneshot`, so routing, middleware ordering,
//! per-caller HMAC verification, boundary validation and the error body are all
//! exercised as deployed rather than by calling handlers directly.
//!
//! Preflight is not involved: `AppState` is built with `protocol_config: None`,
//! which is also the shape a real cold start takes when RPC is briefly unreachable.

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use hmac::{Hmac, KeyInit, Mac};
use sdp_helius_gateway::config::Config;
use sdp_helius_gateway::redact::SecretBytes;
use sdp_helius_gateway::routes;
use sdp_helius_gateway::state::AppState;
use serde_json::{Value, json};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};
use tower::ServiceExt as _;

/// The `sdp-api` caller's secret, for the keyless routes.
const SDP_API_SECRET: &str = "contract-test-secret-of-at-least-32-bytes";
/// The `rings-key-auth` caller's secret, for the key-bearing routes. Deliberately
/// different, so signing with the wrong one is a detectable failure.
const KEY_AUTH_SECRET: &str = "contract-test-key-auth-secret-at-least-32";

/// Which caller a route expects. The gateway verifies against one secret, never
/// either, so this is part of the contract rather than a test convenience.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Caller {
    SdpApi,
    KeyAuth,
}

impl Caller {
    fn secret(self) -> &'static str {
        match self {
            Self::SdpApi => SDP_API_SECRET,
            Self::KeyAuth => KEY_AUTH_SECRET,
        }
    }

    /// The other caller's identity, for the wrong-secret tests.
    fn other(self) -> Self {
        match self {
            Self::SdpApi => Self::KeyAuth,
            Self::KeyAuth => Self::SdpApi,
        }
    }
}

/// Every signed endpoint and the caller it belongs to.
///
/// Exhaustive by design: a new route cannot be added without deciding which caller
/// may sign it, which is the decision that matters most about a new route.
const SIGNED_ENDPOINTS: &[(&str, Caller)] = &[
    ("/v1/wallets/register", Caller::SdpApi),
    ("/v1/wallets/merging", Caller::SdpApi),
    ("/v1/operations/shield", Caller::SdpApi),
    ("/v1/transactions/assemble", Caller::SdpApi),
    ("/v1/nullifiers/status", Caller::SdpApi),
    ("/v1/wallets/sync", Caller::KeyAuth),
    ("/v1/operations/plan", Caller::KeyAuth),
    ("/v1/operations/prove", Caller::KeyAuth),
];

fn app() -> Router {
    let config = Config {
        port: 0,
        hmac_secret_sdp_api: SecretBytes::from_bytes(SDP_API_SECRET.as_bytes().to_vec()),
        hmac_secret_key_auth: SecretBytes::from_bytes(KEY_AUTH_SECRET.as_bytes().to_vec()),
        solana_rpc_url: "https://api.devnet.solana.com".to_owned(),
        photon_url: "https://photon.invalid".to_owned(),
        prover_url: "https://prover.invalid".to_owned(),
        shielded_pool_program_id: sdp_helius_gateway::config::DEFAULT_SHIELDED_POOL_PROGRAM_ID
            .to_owned(),
    };
    routes::app(AppState::new(config, None))
}

fn now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_secs()
        .to_string()
}

/// Mirrors `createHmacSignature` in
/// `packages/sdp-payments/src/fee-payment/kora.adapter.ts`: HMAC-SHA256 over
/// `timestamp + body`, keyed on the secret's UTF-8 bytes, lowercase hex.
fn sign_as(caller: Caller, timestamp: &str, body: &str) -> String {
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(caller.secret().as_bytes()).expect("any length");
    mac.update(timestamp.as_bytes());
    mac.update(body.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn signed_request(path: &str, caller: Caller, body: &str) -> Request<Body> {
    let timestamp = now();
    let signature = sign_as(caller, &timestamp, body);
    Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-timestamp", timestamp)
        .header("x-hmac-signature", signature)
        .body(Body::from(body.to_owned()))
        .expect("valid request")
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

fn b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

const ADDRESS: &str = "11111111111111111111111111111111";

/// A minimal valid preamble, as the key authority would compose it.
///
/// Widths matter and are asymmetric: viewing keys are 32 bytes, the nullifier secret
/// is 31. Indices are the key authority's generation numbers, not array positions.
fn preamble() -> Value {
    json!({
        "requestId": "op_contract_test",
        "owner": ADDRESS,
        "keyMaterial": {
            "viewingKeys": [{ "index": 0, "key": b64(&[3u8; 32]) }],
            "nullifierKey": b64(&[5u8; 31]),
        },
        "walletProjection": null,
        "requireSlot": null,
    })
}

/// A valid keyless registration body. Nothing here is secret.
fn register_body() -> Value {
    json!({
        "requestId": "op_contract_test",
        "owner": ADDRESS,
        "viewingPubkey": b64(&[2u8; 33]),
        "nullifierPubkey": b64(&[4u8; 32]),
        "recentBlockhash": ADDRESS,
        "feePayer": ADDRESS,
    })
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

#[tokio::test]
async fn every_flow_endpoint_is_routed_and_reports_not_implemented() {
    // A body that satisfies no endpoint in particular. Either 501 or 400 proves the
    // route exists and reached its handler or extractor; a 404 would mean it does not.
    let body = json!({ "preamble": preamble() }).to_string();

    for (path, caller) in SIGNED_ENDPOINTS {
        let (status, json) = send(signed_request(path, *caller, &body)).await;
        assert_ne!(status, StatusCode::NOT_FOUND, "{path} is not routed");
        assert!(
            status == StatusCode::NOT_IMPLEMENTED || status == StatusCode::BAD_REQUEST,
            "{path} returned {status} with {json}"
        );
    }
}

#[tokio::test]
async fn register_is_keyless_and_returns_the_error_contract() {
    let body = register_body().to_string();
    let (status, json) = send(signed_request(
        "/v1/wallets/register",
        Caller::SdpApi,
        &body,
    ))
    .await;

    // Reaching the handler with a body that carries no key material is the point:
    // registration is buildable from public halves alone.
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "got {json}");
    // SDP switches on `code`, so the shape matters as much as the status.
    assert_eq!(json["code"], "NOT_IMPLEMENTED");
    assert_eq!(json["retryable"], false);
    assert_eq!(json["reconcile"], false);
}

#[tokio::test]
async fn shield_reaches_its_handler_with_no_key_material() {
    let body = json!({
        "requestId": "op_contract_test",
        "owner": ADDRESS,
        "asset": ADDRESS,
        "amount": "1500000000",
        "splTokenAccount": null,
        "splTokenProgram": null,
        "recentBlockhash": ADDRESS,
        "feePayer": ADDRESS,
        "cuPriceMicroLamports": null,
    })
    .to_string();

    let (status, json) = send(signed_request(
        "/v1/operations/shield",
        Caller::SdpApi,
        &body,
    ))
    .await;

    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "got {json}");
    assert_eq!(json["code"], "NOT_IMPLEMENTED");
}

#[tokio::test]
async fn the_merging_opt_in_is_routed_and_keyless() {
    // The prerequisite that makes merge usable at all: `merging_enabled` defaults to
    // false on a fresh registration, and the program rejects `merge_transact` while
    // it is.
    let body = json!({
        "requestId": "op_contract_test",
        "owner": ADDRESS,
        "enabled": true,
        "recentBlockhash": ADDRESS,
        "feePayer": ADDRESS,
    })
    .to_string();

    let (status, json) = send(signed_request("/v1/wallets/merging", Caller::SdpApi, &body)).await;

    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "got {json}");
    assert_eq!(json["code"], "NOT_IMPLEMENTED");
}

#[tokio::test]
async fn nullifier_status_is_routed_and_keyless() {
    let body = json!({
        "requestId": "op_contract_test",
        "nullifiers": [b64(&[8u8; 32])],
        "requireSlot": 1_234_567_890u64,
    })
    .to_string();

    let (status, json) = send(signed_request(
        "/v1/nullifiers/status",
        Caller::SdpApi,
        &body,
    ))
    .await;

    assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "got {json}");
    assert_eq!(json["code"], "NOT_IMPLEMENTED");
}

#[tokio::test]
async fn an_empty_nullifier_list_is_rejected() {
    let body = json!({ "requestId": "op_x", "nullifiers": [], "requireSlot": null }).to_string();
    let (status, json) = send(signed_request(
        "/v1/nullifiers/status",
        Caller::SdpApi,
        &body,
    ))
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "got {json}");
    assert_eq!(json["code"], "INVALID_REQUEST");
}

#[tokio::test]
async fn unsigned_requests_are_rejected() {
    let request = Request::builder()
        .method("POST")
        .uri("/v1/wallets/sync")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .expect("valid request");

    let (status, _) = send(request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn each_route_rejects_the_other_callers_secret() {
    // The control C6 exists for: a caller who can sign the keyless routes must not be
    // able to sign a key-bearing one, and vice versa. Verification is against one
    // secret, never "either".
    let body = json!({ "preamble": preamble() }).to_string();

    for (path, caller) in SIGNED_ENDPOINTS {
        let (status, _) = send(signed_request(path, caller.other(), &body)).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "{path} accepted a signature from the wrong caller"
        );
    }
}

#[tokio::test]
async fn a_tampered_body_is_rejected() {
    let signed_body = json!({ "preamble": preamble() }).to_string();
    let timestamp = now();
    let signature = sign_as(Caller::KeyAuth, &timestamp, &signed_body);

    // Same signature, different body: exactly what body integrity must catch,
    // and what Cloud Run IAM alone would not.
    let request = Request::builder()
        .method("POST")
        .uri("/v1/wallets/sync")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-timestamp", timestamp)
        .header("x-hmac-signature", signature)
        .body(Body::from(r#"{"preamble":{}}"#))
        .expect("valid request");

    let (status, _) = send(request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_stale_timestamp_is_rejected() {
    let body = json!({ "preamble": preamble() }).to_string();
    let stale = (now().parse::<i64>().expect("numeric") - 3_600).to_string();
    let signature = sign_as(Caller::KeyAuth, &stale, &body);

    let request = Request::builder()
        .method("POST")
        .uri("/v1/wallets/sync")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-timestamp", stale)
        .header("x-hmac-signature", signature)
        .body(Body::from(body))
        .expect("valid request");

    let (status, _) = send(request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "replay window must bind");
}

#[tokio::test]
async fn an_unknown_field_is_rejected_with_our_error_shape() {
    // Otherwise valid, so the typoed field is the only defect under test.
    let mut body = register_body();
    body["typoedField"] = json!("surprise");
    let body = body.to_string();

    let (status, json) = send(signed_request(
        "/v1/wallets/register",
        Caller::SdpApi,
        &body,
    ))
    .await;

    // deny_unknown_fields: a typed contract should reject drift loudly rather
    // than silently ignore a field SDP believed it sent.
    assert_eq!(status, StatusCode::BAD_REQUEST, "got {json}");
    assert_eq!(json["code"], "INVALID_REQUEST");
}

#[tokio::test]
async fn a_validation_error_never_echoes_the_request_body() {
    // On a key-bearing route, because that is where secrets are. Register no longer
    // carries any, so asserting this there would prove nothing.
    let nullifier = b64(&[9u8; 31]);

    // Wrong type on a secret field, which is the case where serde would quote the
    // offending value straight back into the response.
    let body = json!({
        "preamble": {
            "requestId": "op_leak_check",
            "owner": ADDRESS,
            "keyMaterial": {
                "viewingKeys": [{ "index": 0, "key": 12345 }],
                "nullifierKey": nullifier,
            },
            "walletProjection": null,
            "requireSlot": null,
        }
    })
    .to_string();

    let (status, json) = send(signed_request("/v1/wallets/sync", Caller::KeyAuth, &body)).await;
    let rendered = json.to_string();

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        !rendered.contains(&nullifier),
        "key material leaked into the error body: {rendered}"
    );
    assert!(
        !rendered.contains("12345"),
        "serde echoed a body value: {rendered}"
    );
}

#[tokio::test]
async fn the_swapped_key_widths_are_rejected() {
    // The realistic cross-service mistake: a 31-byte viewing key and a 32-byte
    // nullifier secret. Both decode as valid base64, so only a width check catches it.
    let body = json!({
        "preamble": {
            "requestId": "op_swapped",
            "owner": ADDRESS,
            "keyMaterial": {
                "viewingKeys": [{ "index": 0, "key": b64(&[3u8; 31]) }],
                "nullifierKey": b64(&[5u8; 32]),
            },
            "walletProjection": null,
            "requireSlot": null,
        }
    })
    .to_string();

    let (status, json) = send(signed_request("/v1/wallets/sync", Caller::KeyAuth, &body)).await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "got {json}");
    assert_eq!(json["code"], "INVALID_REQUEST");
    // The message names the field and the widths, and nothing else.
    let message = json["message"].as_str().unwrap_or_default();
    assert!(message.contains("viewingKeys"), "got {message}");
    assert!(!message.contains("AwMD"), "base64 of the key leaked");
}

#[tokio::test]
async fn out_of_order_viewing_key_indices_are_rejected() {
    // Indices must be strictly ascending and unique, because that is what lets array
    // position and generation number agree — and a stored counter pointing at the
    // wrong key under-reports a balance silently rather than erroring.
    let body = json!({
        "preamble": {
            "requestId": "op_indices",
            "owner": ADDRESS,
            "keyMaterial": {
                "viewingKeys": [
                    { "index": 5, "key": b64(&[3u8; 32]) },
                    { "index": 2, "key": b64(&[4u8; 32]) },
                ],
                "nullifierKey": b64(&[5u8; 31]),
            },
            "walletProjection": null,
            "requireSlot": null,
        }
    })
    .to_string();

    let (status, json) = send(signed_request("/v1/wallets/sync", Caller::KeyAuth, &body)).await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "got {json}");
    assert_eq!(json["code"], "INVALID_REQUEST");
}

#[tokio::test]
async fn register_rejects_a_wrong_width_public_key() {
    // A viewing pubkey is a 33-byte compressed P256 point. 32 is the plausible slip,
    // and it would otherwise fail deep inside `P256Pubkey::from_bytes`.
    let mut body = register_body();
    body["viewingPubkey"] = json!(b64(&[2u8; 32]));
    let body = body.to_string();

    let (status, json) = send(signed_request(
        "/v1/wallets/register",
        Caller::SdpApi,
        &body,
    ))
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "got {json}");
    assert_eq!(json["code"], "INVALID_REQUEST");
    let message = json["message"].as_str().unwrap_or_default();
    assert!(message.contains("viewingPubkey"), "got {message}");
    assert!(message.contains("33"), "must name the expected width");
}
