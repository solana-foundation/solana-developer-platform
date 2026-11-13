//! The planner against kamino-builder in LiteSVM, over a mainnet USDC vault with 4 reserves: a
//! deposit, withdrawals of one and two legs, and refusals. Each plan is sent, signed by the owner.
//!
//! The tests print the compute units, the builder rounds, and the accounts of each transaction.

mod common;

use anchor_v2_testing::Signer;
use sdp_intents_planner::{Plan, PlanError};
use sdp_intents_program_testing::{send, Documents, SendError};
use solana_address::Address;

use common::*;
use kamino_builder::Refusal;

const USDC_UNIT: u64 = 1_000_000;
const SHARE_UNIT: u64 = 1_000_000;

const KVAULT: &str = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const ASSOCIATED_TOKEN: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/// The kvault error `SharesOutBelowMinimum`.
const SHARES_OUT_BELOW_MINIMUM: u32 = 7064;

fn deposit_documents(wallets: &Wallets, amount: u64, min_shares: u64) -> Result<Documents, String> {
    Documents::compile(&[DEPOSIT_INTERFACE], &[DEPOSIT_RECORD], &deposit_intent(wallets, amount, min_shares))
}

fn withdraw_documents(wallets: &Wallets, shares: u64, min_amount: u64) -> Result<Documents, String> {
    Documents::compile(&[WITHDRAW_INTERFACE], &[WITHDRAW_RECORD], &withdraw_intent(wallets, shares, min_amount))
}

/// The program of each instruction, in base58.
fn programs(plan: &Plan) -> Vec<String> {
    let program = |instruction: &sdp_intents_planner::Instruction| Address::new_from_array(instruction.program.0);

    plan.transaction.instructions.iter().map(|instruction| program(instruction).to_string()).collect()
}

fn report(name: &str, measured: &Measured) {
    let rounds: Vec<String> =
        measured.rounds.iter().map(|round| format!("{} CU and {} accounts", round.units, round.accounts)).collect();

    println!(
        "{name}: {} CU, {} accounts, {} instructions. Builder rounds: {}.",
        measured.plan.units_consumed,
        measured.plan.transaction.accounts().len(),
        measured.plan.transaction.instructions.len(),
        rounds.join("; "),
    );
}

fn refused(code: Refusal) -> Option<PlanError> {
    Some(PlanError::Refused { code: code.code().into(), message: code.message().into() })
}

#[test]
fn deposits_in_two_rounds_and_creates_the_share_account() {
    let Setup { mut svm, wallets } = setup(Holdings { usdc: 1_000 * USDC_UNIT, shares: 0 }).unwrap();
    let documents = deposit_documents(&wallets, 100 * USDC_UNIT, 90 * SHARE_UNIT).unwrap();

    let measured = prepare(&svm, &documents).unwrap();
    report("deposit", &measured);

    assert_eq!(measured.plan.intents[0].builder_simulations, 2);
    assert_eq!(programs(&measured.plan), [ASSOCIATED_TOKEN, KVAULT]);
    assert_eq!(measured.plan.intents[0].outputs, SHARE_MINT.to_bytes());
    assert!(measured.plan.transaction.accounts().len() <= MAX_TRANSACTION_ACCOUNTS);

    send(&mut svm, &measured.plan, &[&wallets.fee_payer, &wallets.owner]).unwrap();

    let owner = wallets.owner.pubkey();
    assert_eq!(balance(&svm, &owner, &USDC).unwrap(), 900 * USDC_UNIT);
    assert!(balance(&svm, &owner, &SHARE_MINT).unwrap() >= 90 * SHARE_UNIT);
}

#[test]
fn the_kvault_program_holds_the_minimum_shares_of_a_deposit() {
    let Setup { mut svm, wallets } = setup(Holdings { usdc: 1_000 * USDC_UNIT, shares: 0 }).unwrap();
    let mut plan = prepare(&svm, &deposit_documents(&wallets, 100 * USDC_UNIT, 90 * SHARE_UNIT).unwrap()).unwrap().plan;
    let deposit = plan.transaction.instructions.last_mut().unwrap();
    deposit.data.splice(16.., u64::MAX.to_le_bytes());

    let Err(SendError::Failed(failed)) = send(&mut svm, &plan, &[&wallets.fee_payer, &wallets.owner]) else {
        panic!("the deposit lands");
    };

    assert!(format!("{:?}", failed.err).ends_with(&format!("Custom({SHARES_OUT_BELOW_MINIMUM}))")));
}

#[test]
fn withdraws_from_the_available_tokens_in_one_leg() {
    let Setup { mut svm, wallets } = setup(Holdings { usdc: 0, shares: 100 * SHARE_UNIT }).unwrap();
    let documents = withdraw_documents(&wallets, 50 * SHARE_UNIT, 50 * USDC_UNIT).unwrap();

    let measured = prepare(&svm, &documents).unwrap();
    report("withdraw, one leg", &measured);

    assert_eq!(measured.plan.intents[0].builder_simulations, 2);
    assert_eq!(programs(&measured.plan), [ASSOCIATED_TOKEN, KVAULT]);

    send(&mut svm, &measured.plan, &[&wallets.fee_payer, &wallets.owner]).unwrap();

    let owner = wallets.owner.pubkey();
    assert_eq!(balance(&svm, &owner, &SHARE_MINT).unwrap(), 50 * SHARE_UNIT);
    assert!(balance(&svm, &owner, &USDC).unwrap() >= 50 * USDC_UNIT);
}

/// 12 million shares need more than the vault's available tokens and its largest reserve.
#[test]
fn withdraws_across_two_reserves_from_live_liquidity() {
    let shares = 12_000_000 * SHARE_UNIT;
    let Setup { mut svm, wallets } = setup(Holdings { usdc: 1, shares }).unwrap();
    let documents = withdraw_documents(&wallets, shares, 12_000_000 * USDC_UNIT).unwrap();

    let measured = prepare(&svm, &documents).unwrap();
    report("withdraw, two legs", &measured);

    assert_eq!(programs(&measured.plan), [KVAULT, KVAULT]);
    assert!(measured.plan.transaction.accounts().len() <= MAX_TRANSACTION_ACCOUNTS);

    send(&mut svm, &measured.plan, &[&wallets.fee_payer, &wallets.owner]).unwrap();

    let owner = wallets.owner.pubkey();
    assert_eq!(balance(&svm, &owner, &SHARE_MINT).unwrap(), 0);
    assert!(balance(&svm, &owner, &USDC).unwrap() >= 12_000_000 * USDC_UNIT);
}

#[test]
fn a_deposit_of_more_than_the_owner_holds_is_refused_in_the_first_round() {
    let Setup { svm, wallets } = setup(Holdings { usdc: 10 * USDC_UNIT, shares: 0 }).unwrap();

    let result = prepare(&svm, &deposit_documents(&wallets, 100 * USDC_UNIT, 0).unwrap());

    assert_eq!(result.err(), refused(Refusal::InsufficientBalance));
}

#[test]
fn a_deposit_minimum_above_the_estimate_is_refused() {
    let Setup { svm, wallets } = setup(Holdings { usdc: 1_000 * USDC_UNIT, shares: 0 }).unwrap();

    let result = prepare(&svm, &deposit_documents(&wallets, 100 * USDC_UNIT, 100 * SHARE_UNIT).unwrap());

    assert_eq!(result.err(), refused(Refusal::SharesBelowMinimum));
}

#[test]
fn a_withdrawal_that_the_reserves_cannot_cover_is_refused() {
    let shares = 14_000_000 * SHARE_UNIT;
    let Setup { svm, wallets } = setup(Holdings { usdc: 0, shares }).unwrap();

    let result = prepare(&svm, &withdraw_documents(&wallets, shares, 0).unwrap());

    assert_eq!(result.err(), refused(Refusal::InsufficientLiquidity));
}

#[test]
fn a_withdrawal_of_more_shares_than_the_owner_holds_is_refused() {
    let Setup { svm, wallets } = setup(Holdings { usdc: 0, shares: 10 * SHARE_UNIT }).unwrap();

    let result = prepare(&svm, &withdraw_documents(&wallets, 20 * SHARE_UNIT, 0).unwrap());

    assert_eq!(result.err(), refused(Refusal::InsufficientShares));
}
