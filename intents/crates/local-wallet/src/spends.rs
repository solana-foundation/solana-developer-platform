//! Shielded spends of the wallet's keys, through Solana Privacy Rings. The intents service asks the
//! wallet to build a spend, because only the key holder can, and the wallet records each spend that
//! it builds, so that it signs only those (`send.rs`).

use base64::Engine as _;
use serde_json::{json, Value};

use sdp_intents_client::json::{base58, instruction as instruction_json};
use sdp_intents_client::message::WireMessage;
use sdp_intents_planner::{ShieldedNote, ShieldedSource, ShieldedSpend};
use sdp_intents_privacy_rings::{nullifier_accounts, Amount, PreparedSpend, Shielded, ShieldedWallet};
use sdp_intents_spec::{Address, ShieldedProtocol};

use crate::error::WalletError;
use crate::Wallet;

/// The local wallets that the ring's registry maps, and why each other one is not mapped.
pub struct Registration {
    pub registered: usize,
    pub failures: Vec<String>,
}

/// How long a build waits for the indexer to show enough private funds.
const BALANCE_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// What a build request asks for: the spend, and who pays the fee.
struct BuildRequest {
    spend: ShieldedSpend,
    fee_payer: Address,
}

impl Wallet {
    /// A body of a shielded call, as the service sends it. Builds and proves the spend with the
    /// spender's keys, records it, and answers its pool instructions and its nullifier accounts.
    pub fn build(&self, body: &Value) -> Result<Value, WalletError> {
        let BuildRequest { spend, fee_payer } = read_build(body)?;
        let [note] = spend.notes.as_slice() else {
            return Err(WalletError::refused("shielded", "a spend here sends exactly one note"));
        };

        if !note.data.is_empty() {
            return Err(WalletError::refused("shielded", "a Privacy Rings transfer here carries no note data"));
        }

        if spend.source == ShieldedSource::Public && note.owner != spend.spender {
            return Err(WalletError::refused("shielded", "a deposit creates a note of the spender only"));
        }

        let wallet = self.shielded_wallet(&spend.spender)?;
        let ring = Shielded::connect(&self.endpoints()?);
        let amount = Amount { asset: solana(note.asset), amount: note.amount };
        let prepared = match spend.source {
            ShieldedSource::Public => ring.prepare_deposit(&wallet, solana(fee_payer), amount.asset, amount.amount)?,
            ShieldedSource::Notes => {
                // A deposit that just landed reaches the indexer a moment later.
                ring.await_balance(&wallet, amount, BALANCE_WAIT)?;
                ring.prepare_transfer(&wallet, solana(fee_payer), solana(note.owner), amount)?
            }
        };

        self.answer(&prepared, spend)
    }

    fn answer(&self, prepared: &PreparedSpend, spend: ShieldedSpend) -> Result<Value, WalletError> {
        let message = WireMessage::parse(&prepared.message_bytes())?;
        let instructions: Vec<_> =
            self.client.decode(&message)?.instructions.into_iter().filter(|built| !built.is_budget()).collect();
        let accounts: Vec<String> = nullifier_accounts(prepared).iter().map(|account| account.to_string()).collect();

        let mut built =
            self.built.lock().map_err(|_| WalletError::failed("wallet", "the record of spends is poisoned"))?;
        instructions.iter().for_each(|pool| {
            built.insert(pool.data.clone(), spend.clone());
        });

        Ok(json!({
            "kind": "instructions",
            "instructions": instructions.iter().map(instruction_json).collect::<Vec<_>>(),
            "outputs": {},
            "nullifierAccounts": accounts,
        }))
    }

    /// Each key's private SOL balance.
    pub fn balances(&self) -> Result<Value, WalletError> {
        let ring = Shielded::connect(&self.endpoints()?);
        let listed = self
            .keys
            .named()
            .iter()
            .map(|named| {
                let wallet = ShieldedWallet::from_seed(named.keypair.secret_bytes())?;
                let lamports = ring.balance(&wallet, solana_address::Address::default())?;

                Ok(json!({ "name": named.name, "address": wallet.address().to_string(), "lamports": lamports }))
            })
            .collect::<Result<Vec<_>, WalletError>>()?;

        Ok(json!({ "wallets": listed }))
    }

    /// A body of `{ "address", "lamports" }`: moves public SOL of a key into a note of its own, and
    /// sends the deposit. A deposit is public.
    pub fn shield(&self, body: &Value) -> Result<Value, WalletError> {
        let owner = address(body.get("address"), "address")?;
        let lamports = body
            .get("lamports")
            .and_then(Value::as_u64)
            .filter(|lamports| *lamports > 0)
            .ok_or_else(|| WalletError::invalid_request("`lamports` is a positive integer"))?;
        let wallet = self.shielded_wallet(&owner)?;
        let ring = Shielded::connect(&self.endpoints()?);

        ring.register(&wallet)?;
        ring.shield_sol(&wallet, lamports)?;

        Ok(json!({ "lamports": lamports }))
    }

    /// Writes each key's registry record when it has none, so that a private transfer can name any
    /// of them as the recipient. A key with no SOL for the rent fails alone.
    pub fn register(&self) -> Result<Registration, WalletError> {
        let ring = Shielded::connect(&self.endpoints()?);
        let failures: Vec<String> = self
            .keys
            .named()
            .iter()
            .filter_map(|named| {
                let registered =
                    ShieldedWallet::from_seed(named.keypair.secret_bytes()).and_then(|wallet| ring.register(&wallet));

                registered.err().map(|error| format!("{}: {error}", named.name))
            })
            .collect();

        Ok(Registration { registered: self.keys.named().len().saturating_sub(failures.len()), failures })
    }

    fn shielded_wallet(&self, owner: &Address) -> Result<ShieldedWallet, WalletError> {
        let seed = self.keys.seed_of(owner).ok_or_else(|| {
            WalletError::refused("unknownKey", format!("the wallet holds no key for {}", base58(owner)))
        })?;

        Ok(ShieldedWallet::from_seed(&seed)?)
    }

    fn endpoints(&self) -> Result<sdp_intents_privacy_rings::Endpoints, WalletError> {
        self.ring.clone().ok_or_else(|| WalletError::refused("noRing", "the wallet started without Privacy Rings"))
    }
}

/// `{ "protocol", "pool", "spender", "source", "feePayer", "notes": [{ "owner", "asset", "amount", "data" }] }`.
fn read_build(body: &Value) -> Result<BuildRequest, WalletError> {
    let protocol = match body.get("protocol").and_then(Value::as_str) {
        Some("privacy-rings") => ShieldedProtocol::PrivacyRings,
        other => return Err(WalletError::refused("protocol", format!("the wallet cannot build a {other:?} spend"))),
    };
    let source = match body.get("source").and_then(Value::as_str) {
        Some("notes") => ShieldedSource::Notes,
        Some("public") => ShieldedSource::Public,
        _ => return Err(WalletError::invalid_request("`source` is `notes` or `public`")),
    };
    let notes = body
        .get("notes")
        .and_then(Value::as_array)
        .ok_or_else(|| WalletError::invalid_request("`notes` is a list"))?
        .iter()
        .map(read_note)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(BuildRequest {
        spend: ShieldedSpend { protocol, spender: address(body.get("spender"), "spender")?, source, notes },
        fee_payer: address(body.get("feePayer"), "feePayer")?,
    })
}

fn read_note(note: &Value) -> Result<ShieldedNote, WalletError> {
    let amount = note
        .get("amount")
        .and_then(Value::as_str)
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| WalletError::invalid_request("a note's `amount` is a decimal integer"))?;
    let data = note
        .get("data")
        .and_then(Value::as_str)
        .map(|text| base64::engine::general_purpose::STANDARD.decode(text))
        .transpose()
        .map_err(|error| WalletError::invalid_request(format!("a note's `data` is not base64: {error}")))?;

    Ok(ShieldedNote {
        owner: address(note.get("owner"), "owner")?,
        asset: address(note.get("asset"), "asset")?,
        amount,
        data: data.unwrap_or_default(),
    })
}

fn address(value: Option<&Value>, name: &str) -> Result<Address, WalletError> {
    value
        .and_then(Value::as_str)
        .and_then(|text| bs58::decode(text).into_vec().ok())
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .map(Address)
        .ok_or_else(|| WalletError::invalid_request(format!("`{name}` is a base58 address")))
}

fn solana(address: Address) -> solana_address::Address {
    solana_address::Address::new_from_array(address.0)
}
