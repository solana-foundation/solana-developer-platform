//! Local keypairs for a playground on a local surfnet. The service signs with them only when it
//! starts with `--wallets`, and never on another cluster's behalf.

use std::path::Path;

use base64::Engine as _;
use serde_json::{json, Value};
use solana_keypair::{read_keypair_file, Keypair};
use solana_signer::Signer as _;

use sdp_intents_chain::CachedRpc;
use sdp_intents_client::sign_message;

use crate::error::ServiceError;

/// The provider's signatures that a plan of a provider's transaction holds, as `presigned`.
pub fn presigned(body: &Value) -> Result<Vec<sdp_intents_planner::ProviderSignature>, ServiceError> {
    let listed = body.get("presigned").and_then(Value::as_array).cloned().unwrap_or_default();

    listed
        .iter()
        .map(|entry| {
            let decode =
                |key: &str| entry.get(key).and_then(Value::as_str).and_then(|text| bs58::decode(text).into_vec().ok());
            let signer = decode("address").and_then(|bytes| <[u8; 32]>::try_from(bytes).ok());
            let signature = decode("signature").and_then(|bytes| <[u8; 64]>::try_from(bytes).ok());

            match (signer, signature) {
                (Some(signer), Some(signature)) => {
                    Ok(sdp_intents_planner::ProviderSignature { signer: sdp_intents_spec::Address(signer), signature })
                }
                _ => Err(ServiceError::invalid_request("each `presigned` entry has a base58 address and signature")),
            }
        })
        .collect()
}

pub struct NamedKeypair {
    pub name: String,
    pub keypair: Keypair,
}

#[derive(Default)]
pub struct Wallets {
    keypairs: Vec<NamedKeypair>,
}

impl Wallets {
    /// Each `<name>.json` keypair file in `folder`, in name order.
    pub fn load(folder: &Path) -> Result<Self, String> {
        let entries =
            std::fs::read_dir(folder).map_err(|error| format!("cannot read `{}`: {error}", folder.display()))?;
        let mut keypairs = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
            .map(|path| {
                let name = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
                let keypair =
                    read_keypair_file(&path).map_err(|error| format!("cannot read `{}`: {error}", path.display()))?;

                Ok(NamedKeypair { name, keypair })
            })
            .collect::<Result<Vec<_>, String>>()?;
        keypairs.sort_by(|left, right| left.name.cmp(&right.name));

        Ok(Self { keypairs })
    }

    pub fn is_empty(&self) -> bool {
        self.keypairs.is_empty()
    }

    pub fn json(&self) -> Value {
        let wallets: Vec<Value> = self
            .keypairs
            .iter()
            .map(|named| json!({ "name": named.name, "address": named.keypair.pubkey().to_string() }))
            .collect();

        json!({ "wallets": wallets })
    }

    /// A body of `{ "message": base64 }`: signs the v1 message with each local wallet that it
    /// requires, and sends it.
    pub async fn send(&self, chain: &CachedRpc, body: &Value) -> Result<Value, ServiceError> {
        if self.is_empty() {
            return Err(ServiceError::not_found("noWallets", "the service started without --wallets"));
        }

        let message = body
            .get("message")
            .and_then(Value::as_str)
            .and_then(|message| base64::engine::general_purpose::STANDARD.decode(message).ok())
            .ok_or_else(|| ServiceError::invalid_request("`message` is the base64 of a v1 message"))?;
        let signers: Vec<&Keypair> = self.keypairs.iter().map(|named| &named.keypair).collect();
        let transaction = sign_message(&message, &signers, &presigned(body)?)?;
        let signature =
            chain.send(&transaction).await.map_err(|error| ServiceError::refused("sendFailed", error.to_string()))?;

        Ok(json!({ "signature": signature.to_string() }))
    }
}
