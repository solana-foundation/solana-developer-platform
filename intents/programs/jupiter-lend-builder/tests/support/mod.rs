//! The USDT market of the Jupiter Lend main market in LiteSVM, and the planner over it.
//!
//! `fixtures/` holds the lending and liquidity programs and the market accounts, dumped from mainnet
//! at slot 468716943. `usdt-market.bin` is a list of records: the address, the owner, the lamports
//! (u64le), the data length (u32le), and the data.

use std::collections::BTreeSet;

use anchor_v2_testing::litesvm::LiteSVM;
use anchor_v2_testing::{Keypair, Signer};
use jupiter_lend_builder::{LENDING_PROGRAM, LIQUIDITY_PROGRAM};
use sdp_intents_builder::offchain::find_associated_token_address as associated_token_address;
use sdp_intents_builder::programs::TOKEN;
use sdp_intents_planner::{AccountMap, Plan, PlanError, Planner, Step};
use sdp_intents_program_testing::{fetch, fixture_program, simulate, svm, Documents};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;

const VAULT_DEPOSIT: &str = include_str!("../../../../definitions/solana.org/interfaces/vault.deposit/1.0.0.json");
const VAULT_WITHDRAW: &str = include_str!("../../../../definitions/solana.org/interfaces/vault.withdraw/1.0.0.json");
const DEPOSIT_IMPLEMENTATION: &str =
    include_str!("../../../../definitions/solana.org/implementations/jupiter-lend-deposit/1.0.0.json");
const WITHDRAW_IMPLEMENTATION: &str =
    include_str!("../../../../definitions/solana.org/implementations/jupiter-lend-withdraw/1.0.0.json");

const BUILDER: &[u8] = include_bytes!("../../../target/deploy/jupiter_lend_builder.so");
pub const MARKET: &[u8] = include_bytes!("../../fixtures/usdt-market.bin");

pub const USDT: Address = Address::from_str_const("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
pub const JLUSDT: Address = Address::from_str_const("Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A");
pub const VAULT: Address = Address::from_str_const("F7tLdeF2YZZex9MR8HgGggyFiz7UU2UgUube2tmfwNPE");

/// One USDT, and one jlUSDT. Both mints have 6 decimals.
pub const UNIT: u64 = 1_000_000;
/// A time after the last update of the dumped market, so that the market accrues forward.
const NOW: i64 = 1_794_528_000;
const SOL: u64 = 1_000_000_000;
const TOKEN_ACCOUNT_RENT: u64 = 2_039_280;
const RECORD_HEADER: usize = 76;
const SCRATCH: sdp_intents_spec::Address = sdp_intents_spec::Address([0x5c; 32]);

pub struct Wallets {
    pub fee_payer: Keypair,
    pub owner: Keypair,
}

pub struct Setup {
    pub svm: LiteSVM,
    pub wallets: Wallets,
}

pub struct FixtureAccount {
    pub address: Address,
    pub account: Account,
}

/// The amount that an intent moves and the least that it accepts back.
pub struct Amounts {
    pub amount: u64,
    pub floor: u64,
}

/// Why a test intent has no plan: its documents do not compile, or the planner fails.
#[derive(Debug)]
pub enum Failure {
    Compile(#[expect(dead_code, reason = "a test that unwraps prints the findings through Debug")] String),
    Plan(PlanError),
}

/// A plan, with what `prepare` cost.
pub struct Measured {
    pub plan: Plan,
    pub fetches: usize,
    /// The compute units of the builder instruction in each builder simulation.
    pub builder_units: Vec<u64>,
}

pub fn setup() -> Result<Setup, String> {
    let mut svm = svm()?;
    svm.add_program(jupiter_lend_builder::id(), BUILDER).map_err(|error| format!("{error:?}"))?;
    let lending = fixture_program(env!("CARGO_MANIFEST_DIR"), "jupiter_lend_lending.so")?;
    let liquidity = fixture_program(env!("CARGO_MANIFEST_DIR"), "jupiter_lend_liquidity.so")?;
    svm.add_program(LENDING_PROGRAM, &lending).map_err(|error| format!("{error:?}"))?;
    svm.add_program(LIQUIDITY_PROGRAM, &liquidity).map_err(|error| format!("{error:?}"))?;

    for fixture in market_accounts(MARKET)? {
        svm.set_account(fixture.address, fixture.account).map_err(|error| format!("{error:?}"))?;
    }

    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = NOW;
    svm.set_sysvar(&clock);

    let wallets = Wallets { fee_payer: Keypair::new(), owner: Keypair::new() };
    svm.airdrop(&wallets.fee_payer.pubkey(), SOL).map_err(|failed| format!("{:?}", failed.err))?;
    svm.airdrop(&wallets.owner.pubkey(), SOL).map_err(|failed| format!("{:?}", failed.err))?;

    Ok(Setup { svm, wallets })
}

pub fn market_accounts(mut bytes: &[u8]) -> Result<Vec<FixtureAccount>, String> {
    let mut accounts = Vec::new();

    while let Some((header, rest)) = bytes.split_first_chunk::<RECORD_HEADER>() {
        let (address, header) = header.split_first_chunk::<32>().ok_or("no address")?;
        let (owner, header) = header.split_first_chunk::<32>().ok_or("no owner")?;
        let (lamports, header) = header.split_first_chunk::<8>().ok_or("no lamports")?;
        let length = u32::from_le_bytes(*header.first_chunk::<4>().ok_or("no length")?);
        let (data, rest) = rest.split_at_checked(length as usize).ok_or("the data is cut")?;

        accounts.push(FixtureAccount {
            address: Address::new_from_array(*address),
            account: Account {
                lamports: u64::from_le_bytes(*lamports),
                data: data.to_vec(),
                owner: Address::new_from_array(*owner),
                executable: false,
                rent_epoch: 0,
            },
        });

        bytes = rest;
    }

    if !bytes.is_empty() {
        return Err("the fixture ends inside a record".into());
    }

    Ok(accounts)
}

pub fn ata(owner: &Address, mint: &Address) -> Result<Address, String> {
    associated_token_address(owner, mint, &TOKEN).ok_or_else(|| "no associated token address".into())
}

/// Puts `amount` of `mint` in the owner's associated token account, and returns its address.
pub fn fund(svm: &mut LiteSVM, owner: &Address, mint: &Address, amount: u64) -> Result<Address, String> {
    let address = ata(owner, mint)?;
    let data = [mint.as_ref(), owner.as_ref(), &amount.to_le_bytes(), &[0; 36], &[1], &[0; 56]].concat();
    let account = Account { lamports: TOKEN_ACCOUNT_RENT, data, owner: TOKEN, executable: false, rent_epoch: 0 };

    svm.set_account(address, account).map_err(|error| format!("{error:?}"))?;

    Ok(address)
}

pub fn balance(svm: &LiteSVM, address: &Address) -> Option<u64> {
    let account = svm.get_account(address)?;

    account.data.get(64..)?.first_chunk::<8>().map(|amount| u64::from_le_bytes(*amount))
}

pub fn signers(wallets: &Wallets) -> [&Keypair; 2] {
    [&wallets.fee_payer, &wallets.owner]
}

pub fn deposit_plan(setup: &Setup, vault: &Address, asset: &Address, amounts: Amounts) -> Result<Measured, Failure> {
    let intent = format!(
        r#"{{
  "spec": "sdp-intents@1.0",
  "kind": "intent",
  "interface": "solana.org/vault.deposit@^1",
  "implementation": "solana.org/jupiter-lend-deposit@^1",
  "inputs": {{ "owner": "{}", "vault": "{vault}", "asset": "{asset}", "amount": "{}", "minShares": "{}" }},
  "options": {{ "verifyIntent": false }}
}}"#,
        setup.wallets.owner.pubkey(),
        amounts.amount,
        amounts.floor,
    );

    let documents =
        Documents::compile(&[VAULT_DEPOSIT], &[DEPOSIT_IMPLEMENTATION], &intent, &setup.wallets.fee_payer.pubkey())
            .map_err(Failure::Compile)?;

    prepare_measured(&setup.svm, &documents).map_err(Failure::Plan)
}

pub fn withdraw_plan(setup: &Setup, amounts: Amounts) -> Result<Measured, Failure> {
    let intent = format!(
        r#"{{
  "spec": "sdp-intents@1.0",
  "kind": "intent",
  "interface": "solana.org/vault.withdraw@^1",
  "implementation": "solana.org/jupiter-lend-withdraw@^1",
  "inputs": {{ "owner": "{}", "vault": "{VAULT}", "asset": "{USDT}", "shares": "{}", "minAmount": "{}" }},
  "options": {{ "verifyIntent": false }}
}}"#,
        setup.wallets.owner.pubkey(),
        amounts.amount,
        amounts.floor,
    );

    let documents =
        Documents::compile(&[VAULT_WITHDRAW], &[WITHDRAW_IMPLEMENTATION], &intent, &setup.wallets.fee_payer.pubkey())
            .map_err(Failure::Compile)?;

    prepare_measured(&setup.svm, &documents).map_err(Failure::Plan)
}

/// `sdp_intents_program_testing::prepare`, which also counts the fetches and reads the builder's
/// compute units from the logs of each builder simulation.
fn prepare_measured(svm: &LiteSVM, documents: &Documents) -> Result<Measured, PlanError> {
    let mut planner = Planner::new(&documents.request(), SCRATCH)?;
    let mut accounts = AccountMap::default();
    let mut fetches = 0usize;
    let mut builder_units = Vec::new();

    loop {
        match planner.next(&accounts)? {
            Step::Fetch(addresses) => {
                fetches = fetches.saturating_add(1);
                let fetched = addresses.iter().map(|address| fetch(svm, address)).collect();
                accounts.insert_fetched(&addresses, fetched);
            }
            // A builder implementation makes no remote call.
            Step::Call(_) | Step::Shield(_) => return Err(sdp_intents_planner::PlanError::OutOfOrder),
            Step::Simulate(simulation) => {
                let result = simulate(svm, &simulation);
                builder_units.extend(builder_units_in(&result.logs));
                planner.simulated(result)?;
            }
            Step::Done(plan) => return Ok(Measured { plan: *plan, fetches, builder_units }),
        }
    }
}

fn builder_units_in(logs: &[String]) -> Option<u64> {
    let prefix = format!("Program {} consumed ", jupiter_lend_builder::id());
    let line = logs.iter().find_map(|line| line.strip_prefix(&prefix))?;

    line.split_once(' ').and_then(|(units, _)| units.parse().ok())
}

/// The distinct accounts of the plan's transaction: the fee payer, the programs, and the metas.
pub fn account_count(plan: &Plan) -> usize {
    let named = plan.transaction.instructions.iter().flat_map(|instruction| {
        core::iter::once(instruction.program.0).chain(instruction.accounts.iter().map(|meta| meta.address.0))
    });

    core::iter::once(plan.transaction.fee_payer.0).chain(named).collect::<BTreeSet<_>>().len()
}

pub fn report(name: &str, measured: &Measured) {
    let plan = &measured.plan;

    println!(
        "{name}: {} CU, builder {:?} CU in {} simulations, {} fetches, {} instructions, {} accounts",
        plan.units_consumed,
        measured.builder_units,
        plan.intents.iter().map(|intent| intent.builder_simulations).sum::<usize>(),
        measured.fetches,
        plan.transaction.instructions.len(),
        account_count(plan),
    );
}
