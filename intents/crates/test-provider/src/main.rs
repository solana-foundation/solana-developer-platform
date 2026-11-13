//! A local stand-in for a provider that signs its own transactions, such as Plume's mint
//! (`DESIGN.md`, 4.16). It answers a remote call for `vault.requestDeposit` with a whole v1
//! transaction: it creates a new order account, which it signs for, and moves the owner's asset to
//! its receiving wallet. The signer adds the owner's and the payers' signatures.
//!
//!   sdp-intents-test-provider [rpc]      listens on 127.0.0.1:8792
//!
//! The order key is new for each transaction, so the provider holds no key between calls. Nothing
//! here holds value on a real cluster.

use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use base64::Engine as _;
use serde_json::{json, Value};
use solana_commitment_config::CommitmentConfig;
use solana_keypair::Keypair;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_signer::Signer as _;

use sdp_intents_client::rpc;
use sdp_intents_planner::{AccountMeta, Budget, Instruction, Transaction};
use sdp_intents_spec::{AccountRole, Address};

/// The wallet that receives each deposit. It needs no key, because it only receives.
const WALLET: &str = "ProviderWa11et11111111111111111111111111111";
const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/// The rent-exempt minimum of an account with no data.
const ORDER_RENT: u64 = 890_880;
const LISTEN: &str = "127.0.0.1:8792";

type Failure = (StatusCode, Json<Value>);

#[tokio::main]
async fn main() -> ExitCode {
    let url = std::env::args().nth(1).unwrap_or_else(|| "http://127.0.0.1:8899".to_owned());
    let rpc = Arc::new(RpcClient::new_with_commitment(url, CommitmentConfig::confirmed()));
    let app = Router::new().route("/deposit", post(deposit)).with_state(rpc);

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

async fn deposit(State(rpc): State<Arc<RpcClient>>, Json(call): Json<Value>) -> Result<Json<Value>, Failure> {
    let order = Keypair::new();
    let transaction = transaction(&rpc, &call, &order).await.map_err(|error| refused(&error))?;

    Ok(Json(
        json!({ "kind": "transaction", "transaction": base64::engine::general_purpose::STANDARD.encode(transaction) }),
    ))
}

/// The transaction in wire form, signed by the order account. The other signatures are empty.
async fn transaction(rpc: &RpcClient, call: &Value, order: &Keypair) -> Result<Vec<u8>, String> {
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
    let transaction = Transaction {
        fee_payer,
        instructions: vec![create_order, pay_wallet],
        budget: Budget {
            compute_unit_limit: 60_000,
            loaded_accounts_data_size_limit: 256 * 1024,
            heap_size: 32 * 1024,
        },
        priority_fee_lamports,
    };

    let (blockhash, _) = rpc
        .get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
        .await
        .map_err(|error| error.to_string())?;
    let message = rpc::message(&transaction, blockhash).map_err(|error| error.to_string())?;
    let required = usize::from(message.header.num_required_signatures);
    let keys: Vec<Address> = message.account_keys.iter().take(required).map(|key| Address(key.to_bytes())).collect();
    let bytes = message.serialize();
    let signatures: Vec<u8> = keys
        .iter()
        .flat_map(|key| match *key == order_address {
            true => <[u8; 64]>::from(order.sign_message(&bytes)),
            false => [0; 64],
        })
        .collect();
    let count = u8::try_from(required).map_err(|_| "too many signers".to_owned())?;

    Ok([&[count][..], &signatures, &bytes].concat())
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
