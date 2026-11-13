//! The planner against the Jupiter Lend builder in LiteSVM: each plan is prepared, checked by the
//! final simulation, signed, and sent. Run with `--nocapture` to see the measurements.

mod support;

use anchor_v2_testing::Signer;
use jupiter_lend_builder::LENDING_PROGRAM;
use sdp_intents_planner::{Instruction, PlanError};
use sdp_intents_program_testing::send;
use solana_address::Address;
use support::{
    ata, balance, deposit_plan, fund, market_accounts, report, setup, signers, withdraw_plan, Amounts, Failure,
    Measured, JLUSDT, MARKET, UNIT, USDT, VAULT,
};

const READONLY: u8 = 0;
const WRITABLE: u8 = 1;
const WRITABLE_SIGNER: u8 = 3;

/// The market accounts of `getDepositContext` and `getWithdrawContext` in `@jup-ag/lend` 0.4.0.
const LENDING_ADMIN: &str = "5nmGjA4s7ATzpBQXC5RNceRpaJ7pYw2wKsNBWyuSAZV6";
const TOKEN_RESERVE: &str = "Enao27EWUV2fv3rUqwknJ1eRaM5aAeN5ijeCrM9tayRX";
const SUPPLY_POSITION: &str = "HVPCmWZ1TN4jUpmewkALAsHSFGLJ1YnYcfVjVai3Pcix";
const RATE_MODEL: &str = "6sAbVeSvEfjQGRAGg9W4PAfhB5qNhYiGdx6Fh9uVEsEC";
const LIQUIDITY_VAULT: &str = "4HTRHjdgy4VSVRcsumuzVFCgWywNhjGsD5oG3kqAt5vo";
const LIQUIDITY: &str = "7s1da8DduuBFqGra5bJBjpnvL5E9mGzCuMk1Qkh4or2Z";
const LIQUIDITY_PROGRAM: &str = "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC";
const REWARDS_RATE_MODEL: &str = "AU7sGinWFZkurwrEdQ9Q8qMtgU6W3GNKfCeCnGQKcBeQ";
const CLAIM_ACCOUNT: &str = "CGgS9fo5ZCFm6weVBotQ7M9qVKuhLrVZnqXH7tee1SZ5";
const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";

fn base58(address: &Address) -> String {
    address.to_string()
}

fn metas(instruction: &Instruction) -> Vec<(String, u8)> {
    let address = |meta: &sdp_intents_planner::AccountMeta| base58(&Address::new_from_array(meta.address.0));

    instruction.accounts.iter().map(|meta| (address(meta), u8::from(meta.role))).collect()
}

fn named(accounts: &[(&str, u8)]) -> Vec<(String, u8)> {
    accounts.iter().map(|(address, role)| ((*address).to_owned(), *role)).collect()
}

fn lending_instruction(measured: &Measured) -> Option<&Instruction> {
    let lending = LENDING_PROGRAM.to_bytes();

    measured.plan.transaction.instructions.iter().find(|instruction| instruction.program.0 == lending)
}

#[test]
fn the_fixture_holds_the_usdt_market() {
    let accounts = market_accounts(MARKET).unwrap();

    assert_eq!(accounts.len(), 11);
    assert!(accounts.iter().any(|fixture| fixture.address == VAULT && fixture.account.owner == LENDING_PROGRAM));
}

#[test]
fn deposits_usdt_into_a_new_share_account() {
    let mut setup = setup().unwrap();
    let owner = setup.wallets.owner.pubkey();
    let asset_account = fund(&mut setup.svm, &owner, &USDT, 250 * UNIT).unwrap();

    let measured = deposit_plan(&setup, &VAULT, &USDT, Amounts { amount: 100 * UNIT, floor: 94 * UNIT }).unwrap();
    report("deposit with a share account create", &measured);

    let plan = &measured.plan;
    assert_eq!(plan.intents[0].builder_simulations, 1);
    assert_eq!(plan.transaction.instructions.len(), 2);
    assert_eq!(plan.intents[0].outputs, JLUSDT.to_bytes());
    assert!(plan.message.contains(&format!(" || 1: deposit 100 of {USDT} from {owner}")));

    send(&mut setup.svm, plan, &signers(&setup.wallets)).unwrap();

    let shares = balance(&setup.svm, &ata(&owner, &JLUSDT).unwrap()).unwrap();
    assert_eq!(balance(&setup.svm, &asset_account), Some(150 * UNIT));
    assert!((94 * UNIT..100 * UNIT).contains(&shares), "{shares} shares");
}

#[test]
fn the_deposit_is_the_instruction_of_the_sdk() {
    let mut setup = setup().unwrap();
    let owner = setup.wallets.owner.pubkey();
    fund(&mut setup.svm, &owner, &USDT, 100 * UNIT).unwrap();

    let measured = deposit_plan(&setup, &VAULT, &USDT, Amounts { amount: 25_500_000, floor: 24_000_000 }).unwrap();
    let deposit = lending_instruction(&measured).unwrap();

    let owner_assets = base58(&ata(&owner, &USDT).unwrap());
    let owner_shares = base58(&ata(&owner, &JLUSDT).unwrap());
    let owner = owner.to_string();
    let (usdt, jlusdt, vault) = (USDT.to_string(), JLUSDT.to_string(), VAULT.to_string());
    let expected = named(&[
        (&owner, WRITABLE_SIGNER),
        (&owner_assets, WRITABLE),
        (&owner_shares, WRITABLE),
        (&usdt, READONLY),
        (LENDING_ADMIN, READONLY),
        (&vault, WRITABLE),
        (&jlusdt, WRITABLE),
        (TOKEN_RESERVE, WRITABLE),
        (SUPPLY_POSITION, WRITABLE),
        (RATE_MODEL, READONLY),
        (LIQUIDITY_VAULT, WRITABLE),
        (LIQUIDITY, WRITABLE),
        (LIQUIDITY_PROGRAM, READONLY),
        (REWARDS_RATE_MODEL, READONLY),
        (TOKEN_PROGRAM, READONLY),
        (ATA_PROGRAM, READONLY),
        (SYSTEM_PROGRAM, READONLY),
    ]);

    let data = [&[116, 144, 16, 97, 118, 109, 40, 119][..], &25_500_000u64.to_le_bytes(), &24_000_000u64.to_le_bytes()];

    assert_eq!(metas(deposit), expected);
    assert_eq!(deposit.data, data.concat());

    let create = measured.plan.transaction.instructions.first().unwrap();
    let rent_payer = setup.wallets.fee_payer.pubkey().to_string();
    let expected_create = named(&[
        (&rent_payer, WRITABLE_SIGNER),
        (&owner_shares, WRITABLE),
        (&owner, READONLY),
        (&jlusdt, READONLY),
        (SYSTEM_PROGRAM, READONLY),
        (TOKEN_PROGRAM, READONLY),
    ]);

    assert_eq!(base58(&Address::new_from_array(create.program.0)), ATA_PROGRAM);
    assert_eq!(metas(create), expected_create);
    assert_eq!(create.data, [1]);
}

#[test]
fn the_withdrawal_is_the_instruction_of_the_sdk() {
    let mut setup = setup().unwrap();
    let owner = setup.wallets.owner.pubkey();
    fund(&mut setup.svm, &owner, &JLUSDT, 10 * UNIT).unwrap();

    let measured = withdraw_plan(&setup, Amounts { amount: 10 * UNIT, floor: 10_400_000 }).unwrap();
    let redeem = lending_instruction(&measured).unwrap();

    let owner_assets = base58(&ata(&owner, &USDT).unwrap());
    let owner_shares = base58(&ata(&owner, &JLUSDT).unwrap());
    let owner = owner.to_string();
    let (usdt, jlusdt, vault) = (USDT.to_string(), JLUSDT.to_string(), VAULT.to_string());
    let expected = named(&[
        (&owner, WRITABLE_SIGNER),
        (&owner_shares, WRITABLE),
        (&owner_assets, WRITABLE),
        (LENDING_ADMIN, READONLY),
        (&vault, WRITABLE),
        (&usdt, READONLY),
        (&jlusdt, WRITABLE),
        (TOKEN_RESERVE, WRITABLE),
        (SUPPLY_POSITION, WRITABLE),
        (RATE_MODEL, READONLY),
        (LIQUIDITY_VAULT, WRITABLE),
        (CLAIM_ACCOUNT, WRITABLE),
        (LIQUIDITY, WRITABLE),
        (LIQUIDITY_PROGRAM, READONLY),
        (REWARDS_RATE_MODEL, READONLY),
        (TOKEN_PROGRAM, READONLY),
        (ATA_PROGRAM, READONLY),
        (SYSTEM_PROGRAM, READONLY),
    ]);

    let data =
        [&[235, 189, 237, 56, 166, 180, 184, 149][..], &10_000_000u64.to_le_bytes(), &10_400_000u64.to_le_bytes()];

    assert_eq!(metas(redeem), expected);
    assert_eq!(redeem.data, data.concat());
}

#[test]
fn withdraws_shares_into_a_new_asset_account() {
    let mut setup = setup().unwrap();
    let owner = setup.wallets.owner.pubkey();
    let share_account = fund(&mut setup.svm, &owner, &JLUSDT, 50 * UNIT).unwrap();

    let measured = withdraw_plan(&setup, Amounts { amount: 50 * UNIT, floor: 52 * UNIT }).unwrap();
    report("withdrawal with an asset account create", &measured);

    let plan = &measured.plan;
    assert_eq!(plan.intents[0].builder_simulations, 1);
    assert_eq!(plan.transaction.instructions.len(), 2);
    assert_eq!(plan.intents[0].outputs, JLUSDT.to_bytes());

    send(&mut setup.svm, plan, &signers(&setup.wallets)).unwrap();

    let assets = balance(&setup.svm, &ata(&owner, &USDT).unwrap()).unwrap();
    assert_eq!(balance(&setup.svm, &share_account), Some(0));
    assert!((52 * UNIT..54 * UNIT).contains(&assets), "{assets} asset atoms");
}

#[test]
fn withdraws_the_shares_of_a_deposit() {
    let mut setup = setup().unwrap();
    let owner = setup.wallets.owner.pubkey();
    let asset_account = fund(&mut setup.svm, &owner, &USDT, 100 * UNIT).unwrap();
    let deposit = deposit_plan(&setup, &VAULT, &USDT, Amounts { amount: 100 * UNIT, floor: 94 * UNIT }).unwrap();
    send(&mut setup.svm, &deposit.plan, &signers(&setup.wallets)).unwrap();
    let shares = balance(&setup.svm, &ata(&owner, &JLUSDT).unwrap()).unwrap();

    let measured = withdraw_plan(&setup, Amounts { amount: shares, floor: 99 * UNIT }).unwrap();
    report("withdrawal", &measured);

    assert_eq!(measured.plan.intents[0].builder_simulations, 1);
    assert_eq!(measured.plan.transaction.instructions.len(), 1);

    send(&mut setup.svm, &measured.plan, &signers(&setup.wallets)).unwrap();

    let assets = balance(&setup.svm, &asset_account).unwrap();
    assert!((99 * UNIT..=100 * UNIT).contains(&assets), "{assets} asset atoms");
}

#[test]
fn a_deposit_into_an_existing_share_account_is_one_instruction() {
    let mut setup = setup().unwrap();
    let owner = setup.wallets.owner.pubkey();
    fund(&mut setup.svm, &owner, &USDT, 100 * UNIT).unwrap();
    fund(&mut setup.svm, &owner, &JLUSDT, 0).unwrap();

    let measured = deposit_plan(&setup, &VAULT, &USDT, Amounts { amount: 100 * UNIT, floor: 94 * UNIT }).unwrap();
    report("deposit", &measured);

    assert_eq!(measured.plan.transaction.instructions.len(), 1);
    send(&mut setup.svm, &measured.plan, &signers(&setup.wallets)).unwrap();
}

fn refusal_code(result: Result<Measured, Failure>) -> Option<String> {
    match result {
        Err(Failure::Plan(PlanError::Refused { code, .. })) => Some(code),
        _ => None,
    }
}

#[test]
fn refuses_a_deposit_of_zero() {
    let setup = setup().unwrap();

    let plan = deposit_plan(&setup, &VAULT, &USDT, Amounts { amount: 0, floor: 0 });

    assert_eq!(refusal_code(plan).as_deref(), Some("zeroAmount"));
}

#[test]
fn refuses_a_deposit_of_more_than_the_owner_holds() {
    let mut setup = setup().unwrap();
    fund(&mut setup.svm, &setup.wallets.owner.pubkey(), &USDT, 10 * UNIT).unwrap();

    let plan = deposit_plan(&setup, &VAULT, &USDT, Amounts { amount: 100 * UNIT, floor: 0 });

    assert_eq!(refusal_code(plan).as_deref(), Some("insufficientBalance"));
}

/// A share is worth more than one asset atom, so a floor equal to the amount is never met.
#[test]
fn refuses_a_share_floor_that_the_vault_price_cannot_meet() {
    let mut setup = setup().unwrap();
    fund(&mut setup.svm, &setup.wallets.owner.pubkey(), &USDT, 100 * UNIT).unwrap();

    let plan = deposit_plan(&setup, &VAULT, &USDT, Amounts { amount: 100 * UNIT, floor: 100 * UNIT });

    assert_eq!(refusal_code(plan).as_deref(), Some("minSharesNotMet"));
}

#[test]
fn refuses_a_vault_of_another_asset() {
    let mut setup = setup().unwrap();
    fund(&mut setup.svm, &setup.wallets.owner.pubkey(), &JLUSDT, 100 * UNIT).unwrap();

    let plan = deposit_plan(&setup, &VAULT, &JLUSDT, Amounts { amount: 100 * UNIT, floor: 0 });

    assert_eq!(refusal_code(plan).as_deref(), Some("vaultAssetMismatch"));
}

#[test]
fn refuses_a_withdrawal_of_zero_shares() {
    let setup = setup().unwrap();

    let plan = withdraw_plan(&setup, Amounts { amount: 0, floor: 0 });

    assert_eq!(refusal_code(plan).as_deref(), Some("zeroShares"));
}

#[test]
fn refuses_a_withdrawal_of_more_shares_than_the_owner_holds() {
    let mut setup = setup().unwrap();
    fund(&mut setup.svm, &setup.wallets.owner.pubkey(), &JLUSDT, 10 * UNIT).unwrap();

    let plan = withdraw_plan(&setup, Amounts { amount: 50 * UNIT, floor: 0 });

    assert_eq!(refusal_code(plan).as_deref(), Some("insufficientShares"));
}

#[test]
fn refuses_a_withdrawal_floor_above_the_vault_liquidity() {
    let mut setup = setup().unwrap();
    fund(&mut setup.svm, &setup.wallets.owner.pubkey(), &JLUSDT, 50 * UNIT).unwrap();

    let plan = withdraw_plan(&setup, Amounts { amount: 50 * UNIT, floor: u64::MAX });

    assert_eq!(refusal_code(plan).as_deref(), Some("insufficientLiquidity"));
}

/// The `applies` hint fails the intent before the builder runs.
#[test]
fn a_vault_that_the_lending_program_does_not_own_fails_before_the_builder() {
    let mut setup = setup().unwrap();
    let asset_account = fund(&mut setup.svm, &setup.wallets.owner.pubkey(), &USDT, 100 * UNIT).unwrap();

    let plan = deposit_plan(&setup, &asset_account, &USDT, Amounts { amount: 100 * UNIT, floor: 0 });

    assert!(matches!(plan, Err(Failure::Plan(PlanError::Engine(_)))));
}
