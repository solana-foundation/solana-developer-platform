//! A shielded spend as JSON, which a `build` asks the caller's wallet to build. The service holds no
//! key and asks no key holder: the caller's wallet or custody builds the spend, and checks its notes
//! before it signs.

use base64::Engine as _;
use serde_json::{json, Value};

use sdp_intents_client::json::base58;
use sdp_intents_planner::{ShieldedCall, ShieldedSource};
use sdp_intents_spec::ShieldedProtocol;

/// The spend that the intent requires: its protocol, pool, spender, the source of its funds, the fee
/// payer, and each note that it creates.
pub fn spend_json(call: &ShieldedCall) -> Value {
    let notes: Vec<Value> = call
        .notes
        .iter()
        .map(|note| {
            json!({
                "owner": base58(&note.owner),
                "asset": base58(&note.asset),
                "amount": note.amount.to_string(),
                "data": base64::engine::general_purpose::STANDARD.encode(&note.data),
            })
        })
        .collect();
    let protocol = match call.protocol {
        ShieldedProtocol::PrivacyRings => "privacy-rings",
    };
    let source = match call.source {
        ShieldedSource::Notes => "notes",
        ShieldedSource::Public => "public",
    };

    json!({
        "protocol": protocol,
        "pool": base58(&call.pool),
        "spender": base58(&call.spender),
        "source": source,
        "feePayer": base58(&call.fee_payer),
        "notes": notes,
    })
}
