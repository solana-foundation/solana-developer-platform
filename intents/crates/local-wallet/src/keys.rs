//! The wallet's keypairs: each `<name>.json` file of the folder that `--wallets` names.

use std::path::Path;

use serde_json::{json, Value};
use solana_keypair::{read_keypair_file, Keypair};
use solana_signer::Signer as _;

use sdp_intents_spec::Address;

pub struct NamedKeypair {
    pub name: String,
    pub keypair: Keypair,
}

pub struct Keys {
    named: Vec<NamedKeypair>,
}

impl Keys {
    /// Each keypair file of `folder`, in name order.
    pub fn load(folder: &Path) -> Result<Self, String> {
        let entries =
            std::fs::read_dir(folder).map_err(|error| format!("cannot read `{}`: {error}", folder.display()))?;
        let mut named = entries
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
        named.sort_by(|left, right| left.name.cmp(&right.name));

        Ok(Self { named })
    }

    pub fn named(&self) -> &[NamedKeypair] {
        &self.named
    }

    pub fn keypairs(&self) -> Vec<&Keypair> {
        self.named.iter().map(|named| &named.keypair).collect()
    }

    /// The Ed25519 seed of the keypair at `address`, from which its shielded keys derive.
    pub fn seed_of(&self, address: &Address) -> Option<[u8; 32]> {
        self.named
            .iter()
            .find(|named| named.keypair.pubkey().to_bytes() == address.0)
            .map(|named| *named.keypair.secret_bytes())
    }

    pub fn json(&self) -> Value {
        let wallets: Vec<Value> = self
            .named
            .iter()
            .map(|named| json!({ "name": named.name, "address": named.keypair.pubkey().to_string() }))
            .collect();

        json!({ "wallets": wallets })
    }
}
