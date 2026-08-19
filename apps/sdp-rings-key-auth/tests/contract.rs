//! Health and startup contract tests.

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use sdp_rings_key_auth::config::Config;
use sdp_rings_key_auth::routes;
use sdp_rings_key_auth::state::AppState;
use serde_json::Value;
use tower::ServiceExt as _;

#[tokio::test]
async fn health_reports_that_production_adapters_are_not_configured() {
    let app = routes::app(AppState::new(
        Config::new(8789).expect("non-zero port is valid"),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .expect("request builds"),
        )
        .await
        .expect("router responds");

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("health body is bounded");
    let payload: Value = serde_json::from_slice(&body).expect("health is JSON");

    assert_eq!(payload["status"], "ok");
    assert_eq!(payload["ready"], false);
    assert_eq!(payload["adapters"]["stageAuthorizer"], false);
    assert_eq!(payload["adapters"]["keyStore"], false);
    assert_eq!(payload["adapters"]["envelopeCipher"], false);
    assert_eq!(payload["adapters"]["gatewayClient"], false);
}

#[test]
fn configuration_rejects_port_zero() {
    assert!(Config::new(0).is_err());
}
