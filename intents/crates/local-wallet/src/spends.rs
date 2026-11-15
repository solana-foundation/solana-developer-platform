//! Shielded spends of the wallet's keys, through Solana Privacy Rings. The intents service asks the
//! wallet to build a spend's statement, because only the key holder can, and the wallet records each
//! spend that it builds, so that it signs only those (`send.rs`).

use serde_json::{json, Value};

use sdp_intents_client::json::{base58, instruction as instruction_json};
use sdp_intents_client::message::WireMessage;
use sdp_intents_planner::{AccountMeta, Instruction, ShieldedCircuit, ShieldedLeg, ShieldedNote, ShieldedSpend};
use sdp_intents_privacy_rings::{
    nullifier_accounts, proving_key_set, Amount, Leg, NoteOut, PreparedSpend, Shielded, ShieldedWallet, Statement,
    TokenAccount,
};
use sdp_intents_spec::wire::{DocumentIdV1, PodU16, SemverV1};
use sdp_intents_spec::{AccountRole, Address, ShieldedProtocol};

use crate::error::WalletError;
use crate::Wallet;

/// The local wallets that the ring's registry maps, and why each other one is not mapped.
pub struct Registration {
    pub registered: usize,
    pub failures: Vec<String>,
}

/// Privacy Rings names SOL by the default address.
const SOL: solana_address::Address = solana_address::Address::new_from_array([0; 32]);

/// How long a build waits for the indexer to show enough private funds.
const BALANCE_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// Where a build proves its spend. The service's prover sees the witness (`DESIGN.md`, 4.17).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProveIn {
    Wallet,
    Service,
}

/// What a build request asks for: the statement, who pays the fee and the rent, and where to prove.
struct BuildRequest {
    spend: ShieldedSpend,
    fee_payer: Address,
    rent_payer: Address,
    prove_in: ProveIn,
}

/// `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, and its `CreateIdempotent`.
const ASSOCIATED_TOKEN_PROGRAM: Address = Address([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142,
    123, 216, 219, 233, 248, 89,
]);
const CREATE_IDEMPOTENT: u8 = 1;

impl Wallet {
    /// The `spend` of a `build`, and `prover`: `wallet` or `service`. Builds and proves the
    /// statement with the spender's keys, records it, and answers its pool instructions and its
    /// nullifier accounts.
    pub fn build(&self, body: &Value) -> Result<Value, WalletError> {
        let BuildRequest { spend, fee_payer, rent_payer, prove_in } = read_build(body)?;

        if spend.circuit.proving_keys != proving_key_set() {
            return Err(WalletError::refused(
                "unknownCircuit",
                "the spend pins a proving key set that this wallet does not hold",
            ));
        }

        let statement = statement(&spend)?;
        let wallet = self.shielded_wallet(&spend.spender)?;
        let ring = Shielded::connect(&self.endpoints()?);

        // A deposit that just landed reaches the indexer a moment later.
        statement
            .consumed()?
            .into_iter()
            .try_for_each(|(asset, amount)| ring.await_balance(&wallet, Amount { asset, amount }, BALANCE_WAIT))?;

        let prover = match prove_in {
            ProveIn::Wallet => self.endpoints()?.prover,
            ProveIn::Service => self.service_prover.clone(),
        };
        let creates: Vec<Instruction> = ring
            .missing_token_accounts(&statement)?
            .into_iter()
            .map(|account| create_token_account(&account, rent_payer))
            .collect();
        let prepared = ring.prepare(&wallet, solana(fee_payer), &statement, &prover)?;

        self.answer(&prepared, spend, creates)
    }

    /// The pool instruction, after `creates`: the recipient token accounts that the pool pays into.
    fn answer(
        &self,
        prepared: &PreparedSpend,
        spend: ShieldedSpend,
        creates: Vec<Instruction>,
    ) -> Result<Value, WalletError> {
        let message = WireMessage::parse(&prepared.message_bytes())?;
        let pool: Vec<Instruction> =
            self.client.decode(&message)?.instructions.into_iter().filter(|built| !built.is_budget()).collect();
        let accounts: Vec<String> = nullifier_accounts(prepared).iter().map(|account| account.to_string()).collect();

        let mut built =
            self.built.lock().map_err(|_| WalletError::failed("wallet", "the record of spends is poisoned"))?;
        pool.iter().for_each(|instruction| {
            built.insert(crate::fingerprint(instruction), spend.clone());
        });

        Ok(json!({
            "kind": "instructions",
            "instructions": creates.iter().chain(&pool).map(instruction_json).collect::<Vec<_>>(),
            "outputs": {},
            "nullifierAccounts": accounts,
        }))
    }

    /// Each key's private balances: its SOL in lamports, and each SPL asset by mint.
    pub fn balances(&self) -> Result<Value, WalletError> {
        let ring = Shielded::connect(&self.endpoints()?);
        let assets =
            self.assets.lock().map_err(|_| WalletError::failed("wallet", "the list of assets is poisoned"))?.clone();
        let listed = self
            .keys
            .named()
            .iter()
            .map(|named| {
                let wallet = ShieldedWallet::from_seed(named.keypair.secret_bytes())?;
                let balances = ring.balances(&wallet, &assets)?;
                let lamports = balances.iter().find(|held| held.asset == SOL).map_or(0, |held| held.amount);
                let tokens: serde_json::Map<String, Value> = balances
                    .iter()
                    .filter(|held| held.asset != SOL)
                    .map(|held| (held.asset.to_string(), Value::from(held.amount.to_string())))
                    .collect();

                Ok(json!({
                    "name": named.name,
                    "address": wallet.address().to_string(),
                    "lamports": lamports,
                    "tokens": tokens,
                }))
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

    /// Creates the pool's SPL interface for each mint, paid by the first key. Returns how many.
    pub fn register_assets(&self, mints: &[String]) -> Result<usize, WalletError> {
        let payer = self
            .keys
            .keypairs()
            .first()
            .copied()
            .ok_or_else(|| WalletError::invalid_request("the wallet holds no key"))?;
        let ring = Shielded::connect(&self.endpoints()?);

        mints.iter().try_for_each(|mint| {
            let mint = mint.parse().map_err(|_| WalletError::invalid_request(format!("`{mint}` is not an address")))?;
            ring.register_asset(payer, mint)?;

            self.remember_asset(mint)
        })?;

        Ok(mints.len())
    }

    /// A body of `{ "payer", "mint" }`: creates the pool's SPL interface for the mint, so that its
    /// tokens can enter the ring. Setup for the local surfnet, where any signer may.
    pub fn register_asset(&self, body: &Value) -> Result<Value, WalletError> {
        let payer = address(body.get("payer"), "payer")?;
        let mint = address(body.get("mint"), "mint")?;
        let keypair = self.keys.keypair_of(&payer).ok_or_else(|| {
            WalletError::refused("unknownKey", format!("the wallet holds no key for {}", base58(&payer)))
        })?;

        Shielded::connect(&self.endpoints()?).register_asset(keypair, solana(mint))?;
        self.remember_asset(solana(mint))?;

        Ok(json!({ "mint": base58(&mint) }))
    }

    fn remember_asset(&self, mint: solana_address::Address) -> Result<(), WalletError> {
        let mut assets =
            self.assets.lock().map_err(|_| WalletError::failed("wallet", "the list of assets is poisoned"))?;

        if !assets.contains(&mint) {
            assets.push(mint);
        }

        Ok(())
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

/// The statement in the protocol's own types. A note here carries no data yet.
fn statement(spend: &ShieldedSpend) -> Result<Statement, WalletError> {
    let value = |asset: Address, amount: u64| Amount { asset: solana(asset), amount };
    let leg = |leg: &ShieldedLeg| Leg { account: solana(leg.account), value: value(leg.asset, leg.amount) };

    if spend.notes.iter().any(|note| !note.data.is_empty()) {
        return Err(WalletError::refused("shielded", "a Privacy Rings note here carries no data"));
    }

    Ok(Statement {
        notes: spend
            .notes
            .iter()
            .map(|note| NoteOut { owner: solana(note.owner), value: value(note.asset, note.amount) })
            .collect(),
        deposits: spend.deposits.iter().map(leg).collect(),
        withdrawals: spend.withdrawals.iter().map(leg).collect(),
    })
}

/// `{ "protocol", "circuit", "spender", "notes", "deposits", "withdrawals", "pool", "feePayer",
/// "rentPayer" }`,
/// the `spend` of a `build`, and `prover`.
fn read_build(body: &Value) -> Result<BuildRequest, WalletError> {
    let spend = body.get("spend").ok_or_else(|| WalletError::invalid_request("`spend` is the spend of a `build`"))?;
    let protocol = match spend.get("protocol").and_then(Value::as_str) {
        Some("privacy-rings") => ShieldedProtocol::PrivacyRings,
        other => return Err(WalletError::refused("protocol", format!("the wallet cannot build a {other:?} spend"))),
    };
    let prove_in = match body.get("prover").and_then(Value::as_str) {
        None | Some("wallet") => ProveIn::Wallet,
        Some("service") => ProveIn::Service,
        Some(other) => {
            return Err(WalletError::invalid_request(format!("`prover` is `wallet` or `service`, not `{other}`")))
        }
    };
    let list = |key: &str| spend.get(key).and_then(Value::as_array).cloned().unwrap_or_default();

    Ok(BuildRequest {
        spend: ShieldedSpend {
            protocol,
            circuit: read_circuit(spend.get("circuit"))?,
            spender: address(spend.get("spender"), "spender")?,
            notes: list("notes").iter().map(read_note).collect::<Result<_, _>>()?,
            deposits: list("deposits").iter().map(read_leg).collect::<Result<_, _>>()?,
            withdrawals: list("withdrawals").iter().map(read_leg).collect::<Result<_, _>>()?,
        },
        fee_payer: address(spend.get("feePayer"), "feePayer")?,
        rent_payer: address(spend.get("rentPayer"), "rentPayer")?,
        prove_in,
    })
}

/// `{ "publisher", "name", "version", "provingKeys" }`. The verifier reads the same circuit from the
/// registry before the wallet signs, so a false one here gets nothing signed.
fn read_circuit(circuit: Option<&Value>) -> Result<ShieldedCircuit, WalletError> {
    let circuit = circuit.ok_or_else(|| WalletError::invalid_request("`circuit` names the spend's circuit"))?;
    let name = circuit
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| WalletError::invalid_request("a circuit has a `name`"))?;
    let version = circuit
        .get("version")
        .and_then(Value::as_str)
        .and_then(read_version)
        .ok_or_else(|| WalletError::invalid_request("a circuit's `version` is `major.minor.patch`"))?;
    let proving_keys = hex(circuit.get("provingKeys"), "provingKeys")?
        .try_into()
        .map_err(|_| WalletError::invalid_request("`provingKeys` is a SHA-256"))?;

    Ok(ShieldedCircuit {
        id: DocumentIdV1 {
            publisher: address(circuit.get("publisher"), "publisher")?,
            name_hash: sdp_intents_registry_client::name_hash(name),
            version,
        },
        name: name.to_owned(),
        proving_keys,
    })
}

fn read_version(text: &str) -> Option<SemverV1> {
    let parts: Vec<u16> = text.split('.').map(str::parse).collect::<Result<_, _>>().ok()?;
    let [major, minor, patch] = parts.as_slice() else {
        return None;
    };

    Some(SemverV1 { major: PodU16::new(*major), minor: PodU16::new(*minor), patch: PodU16::new(*patch) })
}

fn read_note(note: &Value) -> Result<ShieldedNote, WalletError> {
    Ok(ShieldedNote {
        owner: address(note.get("owner"), "owner")?,
        asset: address(note.get("asset"), "asset")?,
        amount: amount(note)?,
        data: note.get("data").map(|data| hex(Some(data), "data")).transpose()?.unwrap_or_default(),
    })
}

fn read_leg(leg: &Value) -> Result<ShieldedLeg, WalletError> {
    Ok(ShieldedLeg {
        account: address(leg.get("account"), "account")?,
        asset: address(leg.get("asset"), "asset")?,
        amount: amount(leg)?,
    })
}

fn amount(entry: &Value) -> Result<u64, WalletError> {
    entry
        .get("amount")
        .and_then(Value::as_str)
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| WalletError::invalid_request("an `amount` is a decimal integer"))
}

fn hex(value: Option<&Value>, name: &str) -> Result<Vec<u8>, WalletError> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| WalletError::invalid_request(format!("`{name}` is hexadecimal")))?;
    let pairs = text.as_bytes().chunks(2);

    match text.len() % 2 {
        0 => pairs
            .map(|pair| core::str::from_utf8(pair).ok().and_then(|pair| u8::from_str_radix(pair, 16).ok()))
            .collect::<Option<Vec<u8>>>()
            .ok_or_else(|| WalletError::invalid_request(format!("`{name}` is hexadecimal"))),
        _ => Err(WalletError::invalid_request(format!("`{name}` is hexadecimal"))),
    }
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

/// `CreateIdempotent` of `account`, funded by the rent payer.
fn create_token_account(account: &TokenAccount, rent_payer: Address) -> Instruction {
    let meta = |address: solana_address::Address, role| AccountMeta { address: Address(address.to_bytes()), role };

    Instruction {
        program: ASSOCIATED_TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta { address: rent_payer, role: AccountRole::WritableSigner },
            meta(account.address, AccountRole::Writable),
            meta(account.owner, AccountRole::Readonly),
            meta(account.mint, AccountRole::Readonly),
            AccountMeta { address: Address::default(), role: AccountRole::Readonly },
            meta(account.token_program, AccountRole::Readonly),
        ],
        data: vec![CREATE_IDEMPOTENT],
    }
}
