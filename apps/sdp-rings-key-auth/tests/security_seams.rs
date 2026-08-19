//! Validation, fail-closed authorization, error, and HMAC tests.

use sdp_rings_key_auth::gateway::auth::sign;
use sdp_rings_key_auth::ports::{RejectingStageAuthorizer, StageAuthorizer, StageToken};
use sdp_rings_key_auth::validate::{StageRequest, Validate};
use sdp_rings_key_auth::wire::api::{OperationStage, PlanRequest, ProveRequest, StageEnvelope};

fn plan_request(stage: OperationStage) -> PlanRequest {
    PlanRequest {
        envelope: StageEnvelope {
            request_id: "req_01".to_owned(),
            organization_id: "org_01".to_owned(),
            wallet_id: "wallet_01".to_owned(),
            operation_id: "op_01".to_owned(),
            stage,
            immutable_hash:
                "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_owned(),
            owner: "11111111111111111111111111111111".to_owned(),
        },
        wallet_projection: None,
        require_slot: Some(42),
        action: serde_json::json!({
            "kind": "transfer",
            "recipient": "11111111111111111111111111111111",
            "amount": "10"
        }),
        fee_payer: "11111111111111111111111111111111".to_owned(),
    }
}

#[test]
fn plan_validation_rejects_a_stage_mismatch_without_echoing_input() {
    let mut request = plan_request(OperationStage::Prove);
    request.action = serde_json::json!({"secret": "plaintext-key-material"});

    let error = request
        .validate()
        .expect_err("plan must require plan stage");
    let response_text = error.to_string();

    assert_eq!(error.code(), "INVALID_REQUEST");
    assert!(!response_text.contains("plaintext-key-material"));
}

#[tokio::test]
async fn production_default_authorizer_fails_closed() {
    let request = plan_request(OperationStage::Plan);
    let token = StageToken::new("opaque-token".to_owned()).expect("non-empty token");

    let error = RejectingStageAuthorizer
        .authorize(&token, &request.envelope)
        .await
        .expect_err("skeleton has no permissive authorizer");

    assert_eq!(error.code(), "ADAPTER_UNAVAILABLE");
}

#[test]
fn outbound_hmac_matches_the_sidecar_vector() {
    let signature = sign(
        b"a-shared-secret-of-at-least-32-bytes",
        "1700000000",
        br#"{"requestId":"op_1"}"#,
    )
    .expect("valid HMAC key");

    assert_eq!(
        signature,
        "31c19c5f58c95decf23f86b9fb2bd0183b91970dc58b151627a4e42dc363d1e0"
    );
}

#[test]
fn immutable_hash_rejects_mutated_stage_content() {
    let mut request = plan_request(OperationStage::Plan);
    request.envelope.immutable_hash = request
        .canonical_hash()
        .expect("canonical plan payload hashes");
    request.validate().expect("matching hash validates");

    request.fee_payer = "SysvarRent111111111111111111111111111111111".to_owned();

    let error = request
        .validate()
        .expect_err("mutated content must not retain authorization");
    assert_eq!(error.code(), "INVALID_REQUEST");
}

#[test]
fn address_validation_requires_a_decoded_32_byte_key() {
    let mut request = plan_request(OperationStage::Plan);
    request.envelope.owner = "22222222222222222222222222222222".to_owned();
    request.envelope.immutable_hash = request
        .canonical_hash()
        .expect("canonical plan payload hashes");

    assert!(request.validate().is_err());
}

#[test]
fn canonical_hash_matches_the_shared_rfc_8785_vector() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/stage-hash-plan.json"))
            .expect("hash fixture is valid JSON");
    let request: PlanRequest =
        serde_json::from_value(fixture["request"].clone()).expect("fixture request is valid");

    assert_eq!(
        request.canonical_hash().expect("request hashes"),
        fixture["sha256"]
            .as_str()
            .expect("fixture hash is a string")
    );
    request
        .validate()
        .expect("fixture hash authorizes its content");
}

#[test]
fn validation_rejects_integers_outside_the_i_json_safe_range() {
    let mut request = plan_request(OperationStage::Plan);
    request.require_slot = Some(9_007_199_254_740_992);
    request.action = serde_json::json!({
        "kind": "test",
        "unsafeInteger": 9_007_199_254_740_993_u64
    });
    request.envelope.immutable_hash = request
        .canonical_hash()
        .expect("canonicalizer accepts the numeric representation");

    assert!(request.validate().is_err());
}

#[test]
fn validation_rejects_floats_outside_the_i_json_safe_range() {
    let mut request = plan_request(OperationStage::Plan);
    request.action = serde_json::from_str(r#"{"kind":"test","unsafeNumber":1e100}"#)
        .expect("test action is valid JSON");
    request.envelope.immutable_hash = request
        .canonical_hash()
        .expect("canonicalizer accepts the numeric representation");

    assert!(request.validate().is_err());
}

#[test]
fn prove_validation_requires_32_byte_base64_commitments() {
    let mut request = ProveRequest {
        envelope: StageEnvelope {
            request_id: "req_01".to_owned(),
            organization_id: "org_01".to_owned(),
            wallet_id: "wallet_01".to_owned(),
            operation_id: "op_01".to_owned(),
            stage: OperationStage::Prove,
            immutable_hash:
                "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_owned(),
            owner: "11111111111111111111111111111111".to_owned(),
        },
        wallet_projection: None,
        require_slot: Some(42),
        action: serde_json::json!({"kind": "merge"}),
        fee_payer: "11111111111111111111111111111111".to_owned(),
        pinned_inputs: vec!["AQ==".to_owned()],
        cu_limit: None,
        cu_price_micro_lamports: None,
    };
    request.envelope.immutable_hash = request
        .canonical_hash()
        .expect("canonical prove payload hashes");

    assert!(request.validate().is_err());
}
