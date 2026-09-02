//! Authenticated route-stub contract tests.
#![allow(clippy::expect_used)]

use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use sdp_rings_key_auth::config::{Config, MAX_BODY_BYTES};
use sdp_rings_key_auth::error::ServiceError;
use sdp_rings_key_auth::ports::{StageAuthorizer, StageToken};
use sdp_rings_key_auth::routes;
use sdp_rings_key_auth::state::AppState;
use sdp_rings_key_auth::validate::StageRequest;
use sdp_rings_key_auth::wire::api::{
    CreateWalletRequest, PlanRequest, ProveRequest, RotateWalletRequest, StageEnvelope, SyncRequest,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tower::ServiceExt as _;

struct AcceptingAuthorizer;

#[async_trait]
impl StageAuthorizer for AcceptingAuthorizer {
    async fn authorize(
        &self,
        token: &StageToken,
        _envelope: &StageEnvelope,
    ) -> Result<(), ServiceError> {
        if token.expose() == "test-stage-token" {
            Ok(())
        } else {
            Err(ServiceError::unauthorized())
        }
    }
}

fn app() -> Router {
    routes::app(AppState::with_authorizer(
        Config::new(8789).expect("test port is valid"),
        Arc::new(AcceptingAuthorizer),
    ))
}

fn envelope(stage: &str) -> Value {
    json!({
        "requestId": "req_01",
        "organizationId": "org_01",
        "walletId": "wallet_01",
        "operationId": "op_01",
        "stage": stage,
        "immutableHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "owner": "11111111111111111111111111111111"
    })
}

fn bind_hash<T>(mut value: Value) -> Value
where
    T: DeserializeOwned + StageRequest,
{
    let request: T = serde_json::from_value(value.clone()).expect("request fixture parses");
    value["envelope"]["immutableHash"] = Value::String(
        request
            .canonical_hash()
            .expect("request fixture canonicalizes"),
    );
    value
}

fn create_body() -> Value {
    bind_hash::<CreateWalletRequest>(json!({"envelope": envelope("provision")}))
}

fn rotate_body() -> Value {
    bind_hash::<RotateWalletRequest>(json!({"envelope": envelope("rotate")}))
}

fn sync_body() -> Value {
    bind_hash::<SyncRequest>(json!({
        "envelope": envelope("sync"),
        "walletProjection": null,
        "requireSlot": 42
    }))
}

fn plan_body() -> Value {
    bind_hash::<PlanRequest>(json!({
        "envelope": envelope("plan"),
        "walletProjection": null,
        "requireSlot": 42,
        "action": {"kind": "merge"},
        "feePayer": "11111111111111111111111111111111"
    }))
}

fn prove_body() -> Value {
    bind_hash::<ProveRequest>(json!({
        "envelope": envelope("prove"),
        "walletProjection": null,
        "requireSlot": 42,
        "action": {"kind": "merge"},
        "feePayer": "11111111111111111111111111111111",
        "pinnedInputs": ["AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM="],
        "cuLimit": null,
        "cuPriceMicroLamports": null
    }))
}

async fn post(app: Router, uri: &str, body: Value, authenticated: bool) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .header("x-request-id", "req_01");
    if authenticated {
        builder = builder.header("authorization", "Bearer test-stage-token");
    }
    let response = app
        .oneshot(
            builder
                .body(Body::from(body.to_string()))
                .expect("request builds"),
        )
        .await
        .expect("router responds");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("response body is bounded");
    let payload = serde_json::from_slice(&bytes).expect("response is stable JSON");
    (status, payload)
}

#[tokio::test]
async fn every_planned_route_is_reachable_and_returns_typed_501() {
    let cases = [
        ("/v1/wallets", create_body()),
        ("/v1/wallets/wallet_01/rotate", rotate_body()),
        ("/v1/wallets/sync", sync_body()),
        ("/v1/operations/plan", plan_body()),
        ("/v1/operations/prove", prove_body()),
    ];

    for (uri, body) in cases {
        let (status, payload) = post(app(), uri, body, true).await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{uri}");
        assert_eq!(payload["code"], "NOT_IMPLEMENTED", "{uri}");
        assert_eq!(payload["requestId"], "req_01", "{uri}");
    }
}

#[tokio::test]
async fn missing_stage_token_is_rejected() {
    let (status, payload) = post(app(), "/v1/operations/plan", plan_body(), false).await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(payload["code"], "UNAUTHORIZED");
}

#[tokio::test]
async fn literal_unset_request_id_header_is_not_treated_as_absent() {
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/operations/plan")
                .header("content-type", "application/json")
                .header("authorization", "Bearer test-stage-token")
                .header("x-request-id", "unset")
                .body(Body::from(plan_body().to_string()))
                .expect("request builds"),
        )
        .await
        .expect("router responds");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let bytes = to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("error body is bounded");
    let payload: Value = serde_json::from_slice(&bytes).expect("error is JSON");
    assert_eq!(payload["code"], "INVALID_REQUEST");
    assert_eq!(payload["requestId"], "unset");
}

#[tokio::test]
async fn production_state_fails_closed_before_stub_execution() {
    let production = routes::app(AppState::new(
        Config::new(8789).expect("test port is valid"),
    ));
    let (status, payload) = post(production, "/v1/operations/plan", plan_body(), true).await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(payload["code"], "ADAPTER_UNAVAILABLE");
}

#[tokio::test]
async fn body_limit_uses_the_stable_error_contract() {
    let oversized = format!(r#"{{"padding":"{}"}}"#, "x".repeat(MAX_BODY_BYTES));
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/operations/plan")
                .header("content-type", "application/json")
                .header("authorization", "Bearer test-stage-token")
                .header("x-request-id", "req_01")
                .body(Body::from(oversized))
                .expect("request builds"),
        )
        .await
        .expect("router responds");

    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let bytes = to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("error body is bounded");
    let payload: Value = serde_json::from_slice(&bytes).expect("error is JSON");
    assert_eq!(payload["code"], "PAYLOAD_TOO_LARGE");
}

#[tokio::test]
async fn malformed_requests_never_echo_supplied_values() {
    let marker = "plaintext-key-material-must-not-escape";
    let body = format!(r#"{{"envelope":{{"stage":"{marker}"}},"action":{{"secret":"{marker}"}}}}"#);
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/operations/plan")
                .header("content-type", "application/json")
                .header("authorization", "Bearer test-stage-token")
                .header("x-request-id", "req_01")
                .body(Body::from(body))
                .expect("request builds"),
        )
        .await
        .expect("router responds");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let bytes = to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("error body is bounded");
    let rendered = String::from_utf8(bytes.to_vec()).expect("error body is UTF-8");
    assert!(!rendered.contains(marker));
    assert!(rendered.contains("INVALID_REQUEST"));
}

#[tokio::test]
async fn rotation_path_must_match_the_authorized_wallet() {
    let (status, payload) = post(
        app(),
        "/v1/wallets/different_wallet/rotate",
        rotate_body(),
        true,
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(payload["code"], "INVALID_REQUEST");
}

#[tokio::test]
async fn envelope_request_id_fallback_is_sanitized_before_reflection() {
    let huge_request_id = "A".repeat(4_096);
    let body = json!({
        "envelope": {
            "requestId": huge_request_id,
            "organizationId": "org_01",
            "walletId": "wallet_01",
            "operationId": "op_01",
            "stage": "plan",
            "immutableHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "owner": "11111111111111111111111111111111"
        },
        "walletProjection": null,
        "requireSlot": 42,
        "action": {"kind": "merge"},
        "feePayer": "11111111111111111111111111111111"
    });
    let response = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/operations/plan")
                .header("content-type", "application/json")
                .header("authorization", "Bearer test-stage-token")
                .body(Body::from(body.to_string()))
                .expect("request builds"),
        )
        .await
        .expect("router responds");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let bytes = to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("error body is bounded");
    let payload: Value = serde_json::from_slice(&bytes).expect("error is JSON");
    assert!(
        payload["requestId"]
            .as_str()
            .expect("request ID is a string")
            .len()
            <= 128
    );
}
