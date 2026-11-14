//! Shielded spends for a playground on a local surfnet. A spend needs the spender's shielded keys,
//! so the service builds one only for a local wallet of `--wallets`, through the ring's indexer and
//! prover.

use axum::http::StatusCode;
use serde_json::{json, Value};

use sdp_intents_client::message::WireMessage;
use sdp_intents_planner::{RemoteAnswer, ShieldedCall, ShieldedSource};
use sdp_intents_privacy_rings::{nullifier_accounts, Amount, Endpoints, PreparedSpend, Shielded, ShieldedWallet};
use sdp_intents_spec::Address;

use crate::error::ServiceError;
use crate::flows::lookup_tables;
use crate::Service;

/// One spend that the ring's SDK builds: a deposit from public funds, or a private transfer.
struct Transfer {
    seed: [u8; 32],
    source: ShieldedSource,
    fee_payer: solana_address::Address,
    to: solana_address::Address,
    amount: Amount,
}

/// A spend for the planner, and the facts of it that a flow keeps (`DESIGN.md`, 4.19).
pub struct Spend {
    /// The spend's pool instructions, which become the segment's built instructions.
    pub answer: RemoteAnswer,
    /// The accounts that the pool creates for the nullifiers that the spend consumes.
    pub nullifier_accounts: Vec<Address>,
}

/// A local wallet as the ring's SDK reads it.
struct RingWallet {
    name: String,
    seed: [u8; 32],
}

/// The local wallets that the ring's registry maps, and why each other one is not mapped.
pub struct Registration {
    pub registered: usize,
    pub failures: Vec<String>,
}

/// Writes each local wallet's registry record when it has none, so that a private transfer can
/// name any of them as the recipient. A wallet with no SOL for the rent fails alone.
pub async fn register_wallets(service: &Service) -> Result<Registration, ServiceError> {
    let endpoints = endpoints(service)?;
    let wallets = ring_wallets(service);

    let failures = blocking(move || {
        let ring = Shielded::connect(&endpoints);
        let register = |wallet: &RingWallet| ring.register(&ShieldedWallet::from_seed(&wallet.seed)?);

        Ok(wallets
            .iter()
            .filter_map(|wallet| register(wallet).err().map(|error| format!("{}: {error}", wallet.name)))
            .collect::<Vec<_>>())
    })
    .await?;

    Ok(Registration { registered: service.wallets.named().len().saturating_sub(failures.len()), failures })
}

/// Each local wallet's private SOL balance, from its unspent notes.
pub async fn balances(service: &Service) -> Result<Value, ServiceError> {
    let endpoints = endpoints(service)?;
    let wallets = ring_wallets(service);

    let listed = blocking(move || {
        let ring = Shielded::connect(&endpoints);

        wallets
            .iter()
            .map(|wallet| {
                let shielded = ShieldedWallet::from_seed(&wallet.seed)?;
                let lamports = ring.balance(&shielded, solana_address::Address::default())?;

                Ok(json!({ "name": wallet.name, "address": shielded.address().to_string(), "lamports": lamports }))
            })
            .collect::<Result<Vec<_>, sdp_intents_privacy_rings::ShieldedError>>()
    })
    .await?;

    Ok(json!({ "wallets": listed }))
}

/// A body of `{ "address": base58, "lamports": n }`: moves public SOL of a local wallet into a note
/// of its own. A deposit is public.
pub async fn shield(service: &Service, body: &Value) -> Result<Value, ServiceError> {
    let endpoints = endpoints(service)?;
    let address = body
        .get("address")
        .and_then(Value::as_str)
        .and_then(|text| bs58::decode(text).into_vec().ok())
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or_else(|| ServiceError::invalid_request("`address` is the base58 address of a local wallet"))?;
    let lamports = body
        .get("lamports")
        .and_then(Value::as_u64)
        .filter(|lamports| *lamports > 0)
        .ok_or_else(|| ServiceError::invalid_request("`lamports` is a positive integer"))?;
    let seed = service
        .wallets
        .seed_of(&Address(address))
        .ok_or_else(|| ServiceError::refused("shielded", "the address is not a local wallet"))?;

    blocking(move || {
        let wallet = ShieldedWallet::from_seed(&seed)?;
        let ring = Shielded::connect(&endpoints);
        ring.register(&wallet)?;
        ring.shield_sol(&wallet, lamports)
    })
    .await?;

    Ok(json!({ "lamports": lamports }))
}

fn endpoints(service: &Service) -> Result<Endpoints, ServiceError> {
    service
        .shielded
        .clone()
        .ok_or_else(|| ServiceError::not_found("noShielded", "the service started without a privacy ring"))
}

fn ring_wallets(service: &Service) -> Vec<RingWallet> {
    service
        .wallets
        .named()
        .iter()
        .map(|named| RingWallet { name: named.name.clone(), seed: *named.keypair.secret_bytes() })
        .collect()
}

/// Runs `work` off the async runtime, because the ring's SDK blocks on the RPC, the indexer, and
/// the prover.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, sdp_intents_privacy_rings::ShieldedError> + Send + 'static,
) -> Result<T, ServiceError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| ServiceError::new(StatusCode::INTERNAL_SERVER_ERROR, "shielded", error.to_string()))?
        .map_err(|error| {
            ServiceError::new(StatusCode::BAD_GATEWAY, "shielded", format!("the privacy ring failed: {error}"))
        })
}

/// Builds and proves the spend that `call` asks for, and returns its instructions. The planner
/// compiles them into the step's transaction, between `verify_intent` and the assertions. The
/// proof covers the pool instruction alone, so the instructions around it leave it valid.
pub async fn answer(service: &Service, call: &ShieldedCall) -> Result<Spend, ServiceError> {
    let endpoints = endpoints(service)?;
    let transfer = transfer(service, call)?;

    let prepared = blocking(move || prepare(&endpoints, &transfer)).await?;

    let message = WireMessage::parse(&prepared.message_bytes())?;
    let tables = lookup_tables(&service.chain, &message.lookup_tables()).await?;
    let instructions =
        message.decode(&tables)?.instructions.into_iter().filter(|instruction| !instruction.is_budget()).collect();
    let nullifier_accounts =
        nullifier_accounts(&prepared).into_iter().map(|account| Address(account.to_bytes())).collect();

    Ok(Spend { answer: RemoteAnswer { instructions, ..RemoteAnswer::default() }, nullifier_accounts })
}

/// The owner's private balance of `mint`, which only a local wallet's viewing key reads.
pub async fn private_balance(service: &Service, owner: &Address, mint: &Address) -> Result<u64, ServiceError> {
    let endpoints = endpoints(service)?;
    let seed = service.wallets.seed_of(owner).ok_or_else(|| {
        ServiceError::refused("shielded", "the owner is not a local wallet, so the service has no viewing key")
    })?;
    let mint = solana(*mint);

    blocking(move || Shielded::connect(&endpoints).balance(&ShieldedWallet::from_seed(&seed)?, mint)).await
}

/// The ring's SDK sends one note to one recipient. A deposit's note is the spender's own.
fn transfer(service: &Service, call: &ShieldedCall) -> Result<Transfer, ServiceError> {
    let [note] = call.notes.as_slice() else {
        return Err(ServiceError::refused("shielded", "a shielded spend here sends exactly one note"));
    };

    if !note.data.is_empty() {
        return Err(ServiceError::refused("shielded", "a private transfer carries no note data"));
    }

    if call.source == ShieldedSource::Public && note.owner != call.spender {
        return Err(ServiceError::refused("shielded", "a deposit creates a note of the spender only"));
    }

    let seed = service.wallets.seed_of(&call.spender).ok_or_else(|| {
        ServiceError::refused("shielded", "the spender is not a local wallet, so the service has no shielded keys")
    })?;

    Ok(Transfer {
        seed,
        source: call.source,
        fee_payer: solana(call.fee_payer),
        to: solana(note.owner),
        amount: Amount { asset: solana(note.asset), amount: note.amount },
    })
}

fn prepare(
    endpoints: &Endpoints,
    transfer: &Transfer,
) -> Result<PreparedSpend, sdp_intents_privacy_rings::ShieldedError> {
    let wallet = ShieldedWallet::from_seed(&transfer.seed)?;
    let ring = Shielded::connect(endpoints);

    match transfer.source {
        ShieldedSource::Public => {
            ring.prepare_deposit(&wallet, transfer.fee_payer, transfer.amount.asset, transfer.amount.amount)
        }
        ShieldedSource::Notes => ring.prepare_transfer(&wallet, transfer.fee_payer, transfer.to, transfer.amount),
    }
}

fn solana(address: Address) -> solana_address::Address {
    solana_address::Address::new_from_array(address.0)
}
