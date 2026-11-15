//! A shielded spend as JSON, which a `build` asks the caller's wallet to build. The service holds no
//! key and asks no key holder: the caller's wallet or custody builds the spend, and checks its
//! statement before it signs.

use serde_json::Value;

use sdp_intents_client::json::{base58, spend};
use sdp_intents_planner::ShieldedCall;

/// The statement that the intent requires, with the pool that the spend calls and the payers.
pub fn spend_json(call: &ShieldedCall) -> Value {
    let mut json = spend(&call.spend);

    if let Some(object) = json.as_object_mut() {
        object.insert("pool".to_owned(), Value::from(base58(&call.pool)));
        object.insert("feePayer".to_owned(), Value::from(base58(&call.fee_payer)));
        object.insert("rentPayer".to_owned(), Value::from(base58(&call.rent_payer)));
    }

    json
}
