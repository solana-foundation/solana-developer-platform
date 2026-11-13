//! A local stand-in for a provider that signs its own transactions, such as Plume's mint
//! (`DESIGN.md`, 4.16). It answers a remote call for `vault.requestDeposit` with a whole
//! transaction: it creates a new order account, which it signs for, and moves the owner's asset to
//! its receiving wallet. The signer adds the owner's and the payers' signatures.
//!
//!   sdp-intents-test-provider [rpc]      listens on 127.0.0.1:8792
//!
//! `POST /format` with `{ "version": "legacy" | "0" | "1", "lookupTable": address | null }` sets the
//! version of the next transactions. A v0 transaction names the accounts of the table through it.
//!
//! The order key is new for each transaction, so the provider holds no key between calls. Nothing
//! here holds value on a real cluster.

use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use serde_json::{json, Value};
use solana_commitment_config::CommitmentConfig;
use solana_keypair::Keypair;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_signer::Signer as _;

use sdp_intents_client::message::{LookupTable, MessageVersion, WireMessage};
use sdp_intents_client::rpc;
use sdp_intents_planner::{Account, AccountMeta, Budget, Instruction, Transaction};
use sdp_intents_spec::{AccountRole, Address};

/// The wallet that receives each deposit. It needs no key, because it only receives.
const WALLET: &str = "ProviderWa11et11111111111111111111111111111";
const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/// The rent-exempt minimum of an account with no data.
const ORDER_RENT: u64 = 890_880;
const LISTEN: &str = "127.0.0.1:8792";

type Failure = (StatusCode, Json<Value>);

struct Provider {
    rpc: RpcClient,
    format: Mutex<Format>,
}

#[derive(Clone, Copy)]
struct Format {
    version: MessageVersion,
    lookup_table: Option<Address>,
}

#[tokio::main]
async fn main() -> ExitCode {
    let url = std::env::args().nth(1).unwrap_or_else(|| "http://127.0.0.1:8899".to_owned());
    let provider = Arc::new(Provider {
        rpc: RpcClient::new_with_commitment(url, CommitmentConfig::confirmed()),
        format: Mutex::new(Format { version: MessageVersion::V1, lookup_table: None }),
    });
    let app = Router::new()
        .route("/deposit", post(deposit))
        .route("/format", get(format).post(set_format))
        .with_state(provider);

    let served = async {
        let address: SocketAddr = LISTEN.parse().map_err(|error| format!("{error}"))?;
        let listener = tokio::net::TcpListener::bind(address).await.map_err(|error| error.to_string())?;
        eprintln!("test provider on http://{LISTEN}");

        axum::serve(listener, app).await.map_err(|error| error.to_string())
    };

    match served.await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn deposit(State(provider): State<Arc<Provider>>, Json(call): Json<Value>) -> Result<Json<Value>, Failure> {
    let order = Keypair::new();
    let format = provider.format().map_err(|error| refused(&error))?;
    let transaction = transaction(&provider.rpc, &call, &order).await.map_err(|error| refused(&error))?;
    let transaction = signed(&provider.rpc, &transaction, format, &order).await.map_err(|error| refused(&error))?;

    Ok(Json(
        json!({ "kind": "transaction", "transaction": base64::engine::general_purpose::STANDARD.encode(transaction) }),
    ))
}

async fn format(State(provider): State<Arc<Provider>>) -> Result<Json<Value>, Failure> {
    let format = provider.format().map_err(|error| refused(&error))?;
    let table = format.lookup_table.map(rpc::base58);

    Ok(Json(json!({ "version": format.version.json(), "lookupTable": table })))
}

async fn set_format(State(provider): State<Arc<Provider>>, Json(body): Json<Value>) -> Result<Json<Value>, Failure> {
    let version = body.get("version").and_then(Value::as_str).and_then(MessageVersion::parse);
    let version = version.ok_or_else(|| refused("`version` is `legacy`, `0`, or `1`"))?;
    let lookup_table = body.get("lookupTable").and_then(Value::as_str).map(address).transpose();
    let lookup_table = lookup_table.map_err(|error| refused(&error))?;

    *provider.format.lock().map_err(|_| refused("the format lock is poisoned"))? = Format { version, lookup_table };

    format(State(provider)).await
}

impl Provider {
    fn format(&self) -> Result<Format, String> {
        self.format.lock().map(|format| *format).map_err(|_| "the format lock is poisoned".to_owned())
    }
}

/// The deposit: a new order account, funded by the rent payer, then the owner's transfer to the
/// receiving wallet.
async fn transaction(rpc: &RpcClient, call: &Value, order: &Keypair) -> Result<Transaction, String> {
    let text =
        |pointer: &str| call.pointer(pointer).and_then(Value::as_str).ok_or(format!("the call has no {pointer}"));
    let owner = address(text("/inputs/owner")?)?;
    let asset = address(text("/inputs/asset")?)?;
    let amount: u64 = text("/inputs/amount")?.parse().map_err(|_| "the amount is not a u64".to_owned())?;
    let fee_payer = address(text("/payers/fee")?)?;
    let rent_payer = address(text("/payers/rent")?)?;
    let priority_fee_lamports: u64 = text("/priorityFeeLamports")?.parse().map_err(|_| "no priority fee".to_owned())?;
    let order_address = Address(order.pubkey().to_bytes());

    let decimals = rpc.get_account_data(&rpc::solana_address(asset)).await.map_err(|error| error.to_string())?;
    let decimals = *decimals.get(44).ok_or("the asset is not a mint")?;
    let token_program = address(TOKEN_PROGRAM)?;
    let ata = |wallet: &Address| {
        sdp_intents_engine::associated_token_account(wallet, &asset, &token_program).ok_or_else(|| "no ATA".to_owned())
    };

    let create_order = Instruction {
        program: Address::default(),
        accounts: vec![meta(rent_payer, AccountRole::WritableSigner), meta(order_address, AccountRole::WritableSigner)],
        data: [&0u32.to_le_bytes()[..], &ORDER_RENT.to_le_bytes(), &0u64.to_le_bytes(), &[0; 32]].concat(),
    };
    let pay_wallet = Instruction {
        program: token_program,
        accounts: vec![
            meta(ata(&owner)?, AccountRole::Writable),
            meta(asset, AccountRole::Readonly),
            meta(ata(&address(WALLET)?)?, AccountRole::Writable),
            meta(owner, AccountRole::ReadonlySigner),
        ],
        data: [&[12u8][..], &amount.to_le_bytes(), &[decimals]].concat(),
    };
    Ok(Transaction {
        fee_payer,
        instructions: vec![create_order, pay_wallet],
        budget: Budget {
            compute_unit_limit: 60_000,
            loaded_accounts_data_size_limit: 256 * 1024,
            heap_size: 32 * 1024,
        },
        priority_fee_lamports,
    })
}

/// The transaction in wire form, of `format`, signed by the order account. The other signatures
/// are empty.
async fn signed(
    rpc: &RpcClient,
    transaction: &Transaction,
    format: Format,
    order: &Keypair,
) -> Result<Vec<u8>, String> {
    let tables = match format.lookup_table {
        Some(table) => vec![lookup_table(rpc, table).await?],
        None => Vec::new(),
    };
    let (blockhash, _) = rpc
        .get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
        .await
        .map_err(|error| error.to_string())?;
    let message =
        WireMessage::compile(transaction, blockhash, format.version, &tables).map_err(|error| error.to_string())?;

    let order_address = Address(order.pubkey().to_bytes());
    let signatures: Vec<[u8; 64]> = message
        .signers()
        .iter()
        .map(|key| match *key == order_address {
            true => <[u8; 64]>::from(order.sign_message(message.bytes())),
            false => [0; 64],
        })
        .collect();

    message.signed(&signatures).map_err(|error| error.to_string())
}

async fn lookup_table(rpc: &RpcClient, address: Address) -> Result<LookupTable, String> {
    let account = rpc.get_account(&rpc::solana_address(address)).await.map_err(|error| error.to_string())?;
    let account = Account { owner: Address(account.owner.to_bytes()), lamports: account.lamports, data: account.data };

    LookupTable::read(address, Some(&account)).map_err(|error| error.to_string())
}

fn meta(address: Address, role: AccountRole) -> AccountMeta {
    AccountMeta { address, role }
}

fn address(text: &str) -> Result<Address, String> {
    let bytes = bs58::decode(text).into_vec().map_err(|error| error.to_string())?;

    bytes.try_into().map(Address).map_err(|_| format!("`{text}` is not an address"))
}

fn refused(error: &str) -> Failure {
    (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": error })))
}
