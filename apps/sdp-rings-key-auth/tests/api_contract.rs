//! Key-authority API contract tests.

use sdp_rings_key_auth::wire::api::{
    IndexedPublicViewingKey, OperationStage, PlanRequest, WalletPublicMaterial,
};
use sdp_rings_key_auth::wire::gateway::{GatewayPlanResponse, GatewaySyncResponse};
use serde_json::json;

#[test]
fn plan_request_carries_all_stage_binding_fields() {
    let request: PlanRequest = serde_json::from_value(json!({
        "envelope": {
            "requestId": "req_01",
            "organizationId": "org_01",
            "walletId": "wallet_01",
            "operationId": "op_01",
            "stage": "plan",
            "immutableHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "owner": "11111111111111111111111111111111"
        },
        "walletProjection": null,
        "requireSlot": 42,
        "action": {
            "kind": "transfer",
            "recipient": "11111111111111111111111111111111",
            "asset": "So11111111111111111111111111111111111111112",
            "amount": "10"
        },
        "feePayer": "11111111111111111111111111111111"
    }))
    .expect("valid plan request");

    assert_eq!(request.envelope.stage, OperationStage::Plan);
    assert_eq!(request.envelope.organization_id, "org_01");
    assert_eq!(request.envelope.operation_id, "op_01");
}

#[test]
fn request_contract_rejects_unknown_fields() {
    let result = serde_json::from_value::<PlanRequest>(json!({
        "envelope": {
            "requestId": "req_01",
            "organizationId": "org_01",
            "walletId": "wallet_01",
            "operationId": "op_01",
            "stage": "plan",
            "immutableHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "owner": "11111111111111111111111111111111",
            "secret": "must-not-be-accepted"
        },
        "walletProjection": null,
        "requireSlot": null,
        "action": {"kind": "merge"},
        "feePayer": "11111111111111111111111111111111"
    }));

    assert!(result.is_err());
}

#[test]
fn provisioning_response_contains_only_public_material() {
    let response = WalletPublicMaterial {
        wallet_id: "wallet_01".to_owned(),
        shielded_address: "shielded-public-address".to_owned(),
        viewing_public_keys: vec![IndexedPublicViewingKey {
            index: 0,
            public_key: "compressed-p256-public-key".to_owned(),
        }],
        nullifier_public_key: "nullifier-public-key".to_owned(),
    };

    let encoded = serde_json::to_string(&response).expect("public response serializes");
    assert!(encoded.contains("viewingPublicKeys"));
    assert!(!encoded.to_ascii_lowercase().contains("secret"));
    assert!(!encoded.contains("keyMaterial"));
}

#[test]
fn typed_gateway_responses_reject_key_material() {
    let result = serde_json::from_value::<GatewayPlanResponse>(json!({
        "inputs": [],
        "ownerSigners": [],
        "shape": {"nIn": 1, "nOut": 2},
        "feePayer": "11111111111111111111111111111111",
        "summary": "merge",
        "totalAmount": "10",
        "syncReport": {
            "storedUtxos": 0,
            "unparsedTransactions": 0,
            "undecryptableCandidates": 0,
            "unknownAssetIds": [],
            "fullRescan": false
        },
        "keyMaterial": "must-not-cross-the-response-boundary"
    }));

    assert!(result.is_err());

    let nested = serde_json::from_value::<GatewaySyncResponse>(json!({
        "balances": [],
        "transactions": [],
        "projection": {
            "version": 1,
            "tagCounters": [],
            "utxos": [],
            "keyMaterial": "must-not-cross-the-response-boundary"
        },
        "syncReport": {
            "storedUtxos": 0,
            "unparsedTransactions": 0,
            "undecryptableCandidates": 0,
            "unknownAssetIds": [],
            "fullRescan": false
        },
        "slot": 42
    }));
    assert!(nested.is_err());
}
