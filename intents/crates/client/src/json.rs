//! The JSON forms of a plan and of a verified transaction, which the CLI prints and the service
//! returns.

use base64::Engine as _;
use serde_json::{json, Value};

use sdp_intents_planner::{Instruction, PlannedIntent, VerifiedIntent, VerifiedTransaction};
use sdp_intents_spec::Address;

use crate::Prepared;

/// A plan in the shape of `DESIGN.md`, section 4.1. `request` is the plan request as JSON.
pub fn plan(prepared: &Prepared, request: Value) -> Value {
    let plan = &prepared.plan;
    let budget = plan.transaction.budget;
    let signatures: Vec<Value> = plan
        .signatures
        .iter()
        .map(|signature| json!({ "address": base58(&signature.address), "role": signature.role.as_text(), "status": "required" }))
        .collect();

    json!({
        "spec": "sdp-intents@1.0",
        "kind": "plan",
        "request": request,
        "message": plan.message,
        "intents": plan.intents.iter().map(intent_json).collect::<Vec<_>>(),
        "transactions": [{
            "instructions": plan.transaction.instructions.iter().map(instruction).collect::<Vec<_>>(),
            "version": 1,
            "config": {
                "priorityFeeLamports": plan.transaction.priority_fee_lamports.to_string(),
                "computeUnitLimit": budget.compute_unit_limit.to_string(),
                "loadedAccountsDataSizeLimit": budget.loaded_accounts_data_size_limit.to_string(),
                "heapSize": budget.heap_size.to_string(),
            },
            "compiled": base64(&prepared.message),
            "lastValidBlockHeight": prepared.last_valid_block_height.map(|height| height.to_string()),
            "presigned": presigned(prepared),
            "signatures": signatures,
        }],
        "simulation": { "unitsConsumed": plan.units_consumed.to_string() },
    })
}

/// `verify` and `span` are positions in the transaction's instructions.
fn intent_json(intent: &PlannedIntent) -> Value {
    json!({
        "display": intent.display,
        "digests": { "interface": digest(&intent.digests.interface), "implementation": digest(&intent.digests.implementation) },
        "builder": intent.builder.map(|program| json!({ "program": base58(&program) })),
        "outputs": base64(&intent.outputs),
        "verify": intent.verify,
        "span": { "start": intent.span.start, "end": intent.span.end },
        "builderSimulations": intent.builder_simulations,
    })
}

/// The `EarnVaultInstruction` shape: base58 addresses, numeric roles, and base64 data.
pub fn instruction(instruction: &Instruction) -> Value {
    let accounts: Vec<Value> = instruction
        .accounts
        .iter()
        .map(|meta| json!({ "address": base58(&meta.address), "role": u8::from(meta.role) }))
        .collect();

    json!({ "programAddress": base58(&instruction.program), "accounts": accounts, "data": base64(&instruction.data) })
}

pub fn base58(address: &Address) -> String {
    bs58::encode(address.0).into_string()
}

pub fn base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn digest(digest: &[u8; 32]) -> String {
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();

    format!("sha256:{hex}")
}

/// The provider's signatures of a plan that is a provider's transaction.
fn presigned(prepared: &Prepared) -> Vec<Value> {
    let signatures = prepared.plan.frozen.iter().flat_map(|frozen| &frozen.signatures);

    signatures
        .map(|signed| json!({ "address": base58(&signed.signer), "signature": bs58::encode(signed.signature).into_string() }))
        .collect()
}

/// What a transaction proves to its signer. `matches` compares the message with `expected`, the
/// message of the plan, when the caller has one.
pub fn verified(verified: &VerifiedTransaction, expected: Option<&str>) -> Value {
    let intent = |intent: &VerifiedIntent| {
        json!({
            "verify": intent.verify,
            "built": { "start": intent.built.start, "end": intent.built.end },
            "segment": { "start": intent.segment.start, "end": intent.segment.end },
        })
    };

    json!({
        "message": verified.message,
        "matches": expected.map(|expected| expected == verified.message),
        "intents": verified.intents.iter().map(intent).collect::<Vec<_>>(),
        "unverified": verified.unverified,
    })
}
