//! Secret-type and sidecar-wire compatibility tests.

use sdp_rings_key_auth::domain::keys::{
    IndexedViewingKey, KeyMaterial, NullifierSecret, ViewingSecret,
};
use sdp_rings_key_auth::domain::sensitive::SensitiveJson;
use sdp_rings_key_auth::ports::SecretBody;
use sdp_rings_key_auth::wire::gateway::{
    GatewayPlanRequest, GatewayPreamble, GatewayProveRequest, GatewaySyncRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use static_assertions::assert_not_impl_any;

assert_not_impl_any!(ViewingSecret: Serialize, Deserialize<'static>);
assert_not_impl_any!(NullifierSecret: Serialize, Deserialize<'static>);
assert_not_impl_any!(SecretBody: Serialize, Clone);
assert_not_impl_any!(SensitiveJson: Clone);

#[test]
fn secret_debug_output_is_redacted() {
    let mut source = [0x41; 32];
    let viewing = ViewingSecret::take(&mut source);
    let rendered = format!("{viewing:?}");

    assert!(source == [0; 32], "constructor must clear caller storage");
    assert!(rendered.contains("[redacted]"));
    assert!(!rendered.contains("AAAA"));
    assert!(!rendered.contains("65"));
}

#[test]
fn gateway_sync_body_matches_the_sidecar_contract_fixture() {
    let material = fixture_material();
    let request = GatewaySyncRequest {
        preamble: fixture_preamble(&material),
    };

    let actual = serde_json::to_value(request).expect("gateway request serializes");
    let expected: Value = serde_json::from_str(include_str!("fixtures/gateway-sync.json"))
        .expect("fixture is valid JSON");

    assert!(
        actual == expected,
        "gateway sync request diverged from its contract fixture"
    );
}

#[test]
fn gateway_plan_body_matches_the_sidecar_contract_fixture() {
    let material = fixture_material();
    let action = merge_action();
    let request = GatewayPlanRequest {
        preamble: fixture_preamble(&material),
        action: &action,
        fee_payer: "11111111111111111111111111111111",
    };

    let actual = serde_json::to_value(request).expect("gateway request serializes");
    let expected: Value = serde_json::from_str(include_str!("fixtures/gateway-plan.json"))
        .expect("fixture is valid JSON");

    assert!(
        actual == expected,
        "gateway plan request diverged from its contract fixture"
    );
}

#[test]
fn gateway_prove_body_matches_the_sidecar_contract_fixture() {
    let material = fixture_material();
    let action = merge_action();
    let pinned_inputs = vec![
        "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=".to_owned(),
        "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=".to_owned(),
    ];
    let request = GatewayProveRequest {
        preamble: fixture_preamble(&material),
        action: &action,
        fee_payer: "11111111111111111111111111111111",
        pinned_inputs: &pinned_inputs,
        cu_limit: Some(400_000),
        cu_price_micro_lamports: Some(1_000),
    };

    let actual = serde_json::to_value(request).expect("gateway request serializes");
    let expected: Value = serde_json::from_str(include_str!("fixtures/gateway-prove.json"))
        .expect("fixture is valid JSON");

    assert!(
        actual == expected,
        "gateway prove request diverged from its contract fixture"
    );
}

#[test]
fn key_material_requires_strictly_ascending_viewing_generations() {
    let mut nullifier = [2; 31];
    let empty = KeyMaterial::new(vec![], NullifierSecret::take(&mut nullifier));
    assert!(empty.is_err());

    let mut first = [1; 32];
    let mut second = [3; 32];
    let mut nullifier = [2; 31];
    let duplicate = KeyMaterial::new(
        vec![
            IndexedViewingKey::new(7, ViewingSecret::take(&mut first)),
            IndexedViewingKey::new(7, ViewingSecret::take(&mut second)),
        ],
        NullifierSecret::take(&mut nullifier),
    );
    assert!(duplicate.is_err());
}

#[test]
fn key_material_rejects_invalid_p256_viewing_secrets() {
    let mut invalid_viewing = [0; 32];
    let mut nullifier = [2; 31];
    let material = KeyMaterial::new(
        vec![IndexedViewingKey::new(
            0,
            ViewingSecret::take(&mut invalid_viewing),
        )],
        NullifierSecret::take(&mut nullifier),
    );

    assert!(material.is_err());
}

#[test]
fn sensitive_json_redacts_and_zeroizes_projection_values() {
    let projection: SensitiveJson = serde_json::from_value(serde_json::json!({
        "utxos": [{"blinding": "plaintext-projection-secret"}]
    }))
    .expect("projection parses");

    let rendered = format!("{projection:?}");
    assert!(rendered.contains("[redacted]"));
    assert!(!rendered.contains("plaintext-projection-secret"));
}

#[allow(clippy::expect_used)]
fn fixture_material() -> KeyMaterial {
    let mut viewing = [1; 32];
    let mut nullifier = [2; 31];
    KeyMaterial::new(
        vec![IndexedViewingKey::new(7, ViewingSecret::take(&mut viewing))],
        NullifierSecret::take(&mut nullifier),
    )
    .expect("viewing generations are valid")
}

fn fixture_preamble(material: &KeyMaterial) -> GatewayPreamble<'_> {
    GatewayPreamble::new(
        "req_01",
        "11111111111111111111111111111111",
        material,
        None,
        Some(42),
    )
}

fn merge_action() -> Value {
    serde_json::json!({
        "kind": "merge",
        "asset": "So11111111111111111111111111111111111111112",
        "inputs": null
    })
}
