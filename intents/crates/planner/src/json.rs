//! The JSON shapes of planner values that more than one caller reads or writes: a shielded
//! statement, and a provider's signatures.

use serde_json::{json, Value};

use sdp_intents_spec::{Address, ShieldedProtocol};

use crate::{ProviderSignature, ShieldedLeg, ShieldedSpend};

/// A shielded statement (`DESIGN.md`, 4.17): the protocol, the circuit pin, the spender, the notes
/// that the spend creates, and its public deposits and withdrawals.
pub fn spend_json(spend: &ShieldedSpend) -> Value {
    let protocol = match spend.protocol {
        ShieldedProtocol::PrivacyRings => "privacy-rings",
    };
    let notes: Vec<Value> = spend
        .notes
        .iter()
        .map(|note| {
            json!({
                "owner": base58(&note.owner),
                "asset": base58(&note.asset),
                "amount": note.amount.to_string(),
                "data": hex(&note.data),
            })
        })
        .collect();
    let legs = |legs: &[ShieldedLeg]| -> Vec<Value> {
        legs.iter()
            .map(|leg| json!({ "account": base58(&leg.account), "asset": base58(&leg.asset), "amount": leg.amount.to_string() }))
            .collect()
    };
    let version = spend.circuit.id.version;

    json!({
        "protocol": protocol,
        "circuit": {
            "publisher": base58(&spend.circuit.id.publisher),
            "name": spend.circuit.name,
            "version": format!("{}.{}.{}", version.major.get(), version.minor.get(), version.patch.get()),
            "provingKeys": hex(&spend.circuit.proving_keys),
        },
        "spender": base58(&spend.spender),
        "notes": notes,
        "deposits": legs(&spend.deposits),
        "withdrawals": legs(&spend.withdrawals),
    })
}

/// The `presigned` list of a plan of a provider's transaction: each entry's base58 address and
/// signature. An absent list is empty.
pub fn presigned_from_json(listed: Option<&Value>) -> Result<Vec<ProviderSignature>, &'static str> {
    const WRONG: &str = "each `presigned` entry has a base58 address and signature";

    let Some(listed) = listed else {
        return Ok(Vec::new());
    };

    listed
        .as_array()
        .ok_or("`presigned` is a list")?
        .iter()
        .map(|entry| {
            let decode =
                |key: &str| entry.get(key).and_then(Value::as_str).and_then(|text| bs58::decode(text).into_vec().ok());
            let signer = decode("address").and_then(|bytes| <[u8; 32]>::try_from(bytes).ok()).ok_or(WRONG)?;
            let signature = decode("signature").and_then(|bytes| <[u8; 64]>::try_from(bytes).ok()).ok_or(WRONG)?;

            Ok(ProviderSignature { signer: Address(signer), signature })
        })
        .collect()
}

pub fn base58(address: &Address) -> String {
    bs58::encode(address.0).into_string()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_presigned_entries_and_refuses_a_malformed_one() {
        let signer = Address([4; 32]);
        let entry = json!([{ "address": base58(&signer), "signature": bs58::encode([9u8; 64]).into_string() }]);

        assert_eq!(presigned_from_json(Some(&entry)), Ok(vec![ProviderSignature { signer, signature: [9; 64] }]));
        assert_eq!(presigned_from_json(None), Ok(Vec::new()));
        assert!(presigned_from_json(Some(&json!([{ "address": "x" }]))).is_err());
        assert!(presigned_from_json(Some(&json!({}))).is_err());
    }
}
