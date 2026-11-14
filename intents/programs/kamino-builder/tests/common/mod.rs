//! The LiteSVM setup of the plan tests: the kvault and klend programs and one USDC vault from
//! mainnet fixtures, at the fixture's clock, and an owner with USDC or vault shares.

use anchor_v2_testing::litesvm::LiteSVM;
use anchor_v2_testing::{Keypair, Signer};
use base64::Engine as _;
use solana_account::Account;
use solana_address::Address;

use sdp_intents_planner::{AccountMap, Plan, PlanError, Planner, Step};
use sdp_intents_program_testing::{fetch, fixture_program, simulate, Documents};

pub const VAULT: Address = Address::from_str_const("HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E");
pub const USDC: Address = Address::from_str_const("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
pub const SHARE_MINT: Address = Address::from_str_const("7D8C5pDFxug58L9zkwK7bCiDg4kD4AygzbcZUmf5usHS");
pub const TOKEN_PROGRAM: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const KVAULT: Address = Address::from_str_const("KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd");
const KLEND: Address = Address::from_str_const("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

const BUILDER_PROGRAM: &[u8] = include_bytes!("../../../target/deploy/kamino_builder.so");
const FIXTURE_ACCOUNTS: &str = include_str!("../../fixtures/accounts.json");

pub const DEPOSIT_INTERFACE: &str =
    include_str!("../../../../definitions/solana.org/interfaces/vault.deposit/1.0.0.json");
pub const WITHDRAW_INTERFACE: &str =
    include_str!("../../../../definitions/solana.org/interfaces/vault.withdraw/1.0.0.json");
pub const DEPOSIT_IMPLEMENTATION: &str =
    include_str!("../../../../definitions/solana.org/implementations/kamino-deposit/1.0.0.json");
pub const WITHDRAW_IMPLEMENTATION: &str =
    include_str!("../../../../definitions/solana.org/implementations/kamino-withdraw/1.0.0.json");

const SOL: u64 = 1_000_000_000;
const TOKEN_ACCOUNT_RENT: u64 = 2_039_280;
/// The v1 transaction limit of SIMD-0385, which has no lookup tables.
pub const MAX_TRANSACTION_ACCOUNTS: usize = 64;

pub struct Wallets {
    pub fee_payer: Keypair,
    pub owner: Keypair,
}

pub struct Setup {
    pub svm: LiteSVM,
    pub wallets: Wallets,
}

/// The owner's balances, in base units. A zero balance has no token account.
pub struct Holdings {
    pub usdc: u64,
    pub shares: u64,
}

pub fn setup(holdings: Holdings) -> Result<Setup, String> {
    let mut svm = sdp_intents_program_testing::svm()?;
    svm.add_program(kamino_builder::id(), BUILDER_PROGRAM).map_err(debug)?;
    svm.add_program(KVAULT, &fixture_program(env!("CARGO_MANIFEST_DIR"), "kvault.so")?).map_err(debug)?;
    svm.add_program(KLEND, &fixture_program(env!("CARGO_MANIFEST_DIR"), "klend.so")?).map_err(debug)?;
    load_fixture_accounts(&mut svm)?;

    let wallets = Wallets { fee_payer: Keypair::new(), owner: Keypair::new() };
    svm.airdrop(&wallets.fee_payer.pubkey(), SOL).map_err(|failed| format!("{:?}", failed.err))?;

    let owner = wallets.owner.pubkey();
    let balances = [(USDC, holdings.usdc), (SHARE_MINT, holdings.shares)];

    for (mint, amount) in balances.into_iter().filter(|(_, amount)| *amount > 0) {
        svm.set_account(token_address(&owner, &mint)?, token_account(&mint, &owner, amount)).map_err(debug)?;
    }

    Ok(Setup { svm, wallets })
}

fn debug(error: impl core::fmt::Debug) -> String {
    format!("{error:?}")
}

/// Every account of `accounts.json`, the clock included, so the reserves are fresh at the clock.
fn load_fixture_accounts(svm: &mut LiteSVM) -> Result<(), String> {
    let entries: serde_json::Value = serde_json::from_str(FIXTURE_ACCOUNTS).map_err(debug)?;
    let entries = entries.as_array().ok_or("the fixture is not a list")?;

    entries.iter().try_for_each(|entry| {
        let text = |value: &serde_json::Value| value.as_str().map(str::to_owned).ok_or("a field is not a string");
        let account = &entry["account"];
        let encoded = account["data"].get(0).ok_or("an account has no data")?;
        let data = base64::engine::general_purpose::STANDARD.decode(text(encoded)?).map_err(debug)?;
        let owner: Address = text(&account["owner"])?.parse().map_err(debug)?;
        let lamports = account["lamports"].as_u64().ok_or("lamports are not a number")?;
        let address: Address = text(&entry["pubkey"])?.parse().map_err(debug)?;

        svm.set_account(address, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).map_err(debug)
    })
}

pub fn token_address(owner: &Address, mint: &Address) -> Result<Address, String> {
    sdp_intents_builder::offchain::find_associated_token_address(owner, mint, &TOKEN_PROGRAM)
        .ok_or("no token address".into())
}

/// An initialized SPL Token account.
fn token_account(mint: &Address, owner: &Address, amount: u64) -> Account {
    let initialized = [1u8];
    let data = [mint.as_ref(), owner.as_ref(), &amount.to_le_bytes(), &[0; 36], &initialized, &[0; 56]].concat();

    Account { lamports: TOKEN_ACCOUNT_RENT, data, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }
}

pub fn balance(svm: &LiteSVM, owner: &Address, mint: &Address) -> Result<u64, String> {
    let Some(account) = svm.get_account(&token_address(owner, mint)?) else {
        return Ok(0);
    };
    let amount = account.data.get(64..72).and_then(|bytes| bytes.first_chunk::<8>()).ok_or("not a token account")?;

    Ok(u64::from_le_bytes(*amount))
}

pub fn deposit_intent(wallets: &Wallets, amount: u64, min_shares: u64) -> String {
    intent("vault.deposit", "kamino-deposit", wallets, &format!(r#""amount": "{amount}", "minShares": "{min_shares}""#))
}

pub fn withdraw_intent(wallets: &Wallets, shares: u64, min_amount: u64) -> String {
    intent(
        "vault.withdraw",
        "kamino-withdraw",
        wallets,
        &format!(r#""shares": "{shares}", "minAmount": "{min_amount}""#),
    )
}

fn intent(interface: &str, implementation: &str, wallets: &Wallets, amounts: &str) -> String {
    format!(
        r#"{{
  "spec": "sdp-intents@1.0",
  "kind": "intent",
  "interface": "solana.org/{interface}@^1",
  "implementation": "solana.org/{implementation}@^1",
  "inputs": {{ "owner": "{}", "vault": "{VAULT}", "asset": "{USDC}", {amounts} }},
  "options": {{ "verifyIntent": false }}
}}"#,
        wallets.owner.pubkey(),
    )
}

/// One builder simulation: its compute units and the accounts of its transaction.
#[derive(Debug)]
pub struct Round {
    pub units: u64,
    pub accounts: usize,
}

pub struct Measured {
    pub plan: Plan,
    pub rounds: Vec<Round>,
}

/// `sdp_intents_program_testing::prepare`, which also measures each builder simulation. The final
/// simulation is the last one, and the plan holds its units.
pub fn prepare(svm: &LiteSVM, documents: &Documents) -> Result<Measured, PlanError> {
    let mut planner = Planner::new(&documents.request(), SCRATCH)?;
    let mut accounts = AccountMap::default();
    let mut rounds = Vec::new();

    loop {
        match planner.next(&accounts)? {
            Step::Fetch(addresses) => {
                let fetched = addresses.iter().map(|address| fetch(svm, address)).collect();
                accounts.insert_fetched(&addresses, fetched);
            }
            // A builder implementation makes no remote call.
            Step::Call(_) | Step::Shield(_) => return Err(sdp_intents_planner::PlanError::OutOfOrder),
            Step::Simulate(simulation) => {
                let result = simulate(svm, &simulation);
                let units = result.units_consumed.unwrap_or_default();
                rounds.push(Round { units, accounts: simulation.transaction.accounts().len() });
                planner.simulated(result)?;
            }
            Step::Done(plan) => {
                rounds.pop();
                return Ok(Measured { plan: *plan, rounds });
            }
        }
    }
}

const SCRATCH: sdp_intents_spec::Address = sdp_intents_spec::Address([0x5c; 32]);
