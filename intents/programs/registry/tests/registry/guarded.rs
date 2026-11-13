//! Plans with the default onchain checks: `verify_intent` and the Lighthouse assertions, against
//! the Lighthouse program of mainnet.

use anchor_lang::Address;
use anchor_v2_testing::litesvm::LiteSVM;
use anchor_v2_testing::{Keypair, Signer};
use registry::RegistryError;
use sdp_intents_lighthouse::LIGHTHOUSE_PROGRAM;
use sdp_intents_planner::Plan;
use sdp_intents_program_testing::{definitions, prepare, prepare_intents, verify};

use crate::intents::{publish_transfer, spec_address, Published};
use crate::svm::{failure, funded, send_plan, svm, units_consumed, Failure, SOL};
use crate::token::{associated_token_account, set_mint, set_token_account, token_amount};

const TEST_BUILDER_TRANSFER: &str = include_str!("../../../test-builder/fixtures/test-builder-transfer.json");

struct Setup {
    svm: LiteSVM,
    published: Published,
    fee_payer: Keypair,
    from: Keypair,
    to: Keypair,
}

fn setup(implementation: &'static str) -> Result<Setup, Failure> {
    let mut svm = svm()?;
    let published = publish_transfer(&mut svm, implementation, true)?;
    let fee_payer = funded(&mut svm, SOL)?;
    let from = funded(&mut svm, 10 * SOL)?;

    Ok(Setup { svm, published, fee_payer, from, to: Keypair::new() })
}

/// A transfer with no options, so both onchain checks are on.
fn intent(setup: &Setup, implementation: &str, mint: &Address, amount: u64) -> String {
    let memo = if mint == &Address::default() { "" } else { r#", "memo": null"# };

    format!(
        r#"{{
  "spec": "sdp-intents@1.0",
  "kind": "intent",
  "interface": "solana.org/token.transfer@^1",
  "implementation": "solana.org/{implementation}@^1",
  "inputs": {{ "from": "{}", "to": "{}", "mint": "{mint}", "amount": "{amount}"{memo} }}
}}"#,
        setup.from.pubkey(),
        setup.to.pubkey(),
    )
}

fn plan(
    setup: &Setup,
    implementation: &str,
    mint: &Address,
    amount: u64,
    fee_payer: &Address,
) -> Result<Plan, Failure> {
    let documents = setup.published.compile(&intent(setup, implementation, mint, amount), fee_payer)?;

    prepare(&setup.svm, &documents).map_err(|error| failure(format!("{error}")))
}

fn lighthouse_count(plan: &Plan) -> usize {
    plan.transaction.instructions.iter().filter(|instruction| instruction.program == LIGHTHOUSE_PROGRAM).count()
}

fn lamports(svm: &LiteSVM, address: &Address) -> Option<u64> {
    svm.get_account(address).map(|account| account.lamports)
}

/// The sender's lamports are the guarded value: one snapshot, one assertion, and the close.
#[test]
fn verifies_a_sol_transfer_with_the_default_checks() {
    let mut setup = setup(definitions::SYSTEM_TRANSFER).unwrap();
    let plan = plan(&setup, "system-transfer", &Address::default(), 2 * SOL, &setup.fee_payer.pubkey()).unwrap();

    assert_eq!(lighthouse_count(&plan), 3);
    assert!(plan.message.contains(" | onchain checks: verify_intent, assertions | rent cap 890880 lamports"));

    let sent = send_plan(&mut setup.svm, &plan, &[&setup.fee_payer, &setup.from]).unwrap();
    let units = units_consumed(&sent.logs, &registry::ID).unwrap();
    println!("verify_intent with assertions, system-transfer: {units} CU, the plan {} CU", plan.units_consumed);

    assert_eq!(lamports(&setup.svm, &setup.to.pubkey()), Some(2 * SOL));
}

/// The sender pays the fee and the rent, so its lamports may fall by the rent cap, and its token
/// account by the amount.
#[test]
fn verifies_a_token_transfer_that_its_sender_pays_for() {
    let mut setup = setup(definitions::SPL_TOKEN_TRANSFER).unwrap();
    let mint = Keypair::new().pubkey();
    let source = associated_token_account(&setup.from.pubkey(), &mint);
    set_mint(&mut setup.svm, &mint, 6).unwrap();
    set_token_account(&mut setup.svm, &source, &mint, &setup.from.pubkey(), 500_000_000).unwrap();

    let plan = plan(&setup, "spl-token-transfer", &mint, 100_000_000, &setup.from.pubkey()).unwrap();

    let rent = setup.svm.minimum_balance_for_rent_exemption(165);
    // Rule 3 adds the sender's token account: its owner, delegate, and close authority.
    assert_eq!(lighthouse_count(&plan), 8);
    assert!(plan.message.contains(&format!(" | rent cap {rent} lamports || ")), "{}", plan.message);
    assert_eq!(verify(&setup.svm, &plan.transaction).unwrap().message, plan.message);

    let sent = send_plan(&mut setup.svm, &plan, &[&setup.from]).unwrap();
    let units = units_consumed(&sent.logs, &registry::ID).unwrap();
    println!("verify_intent with assertions, spl-token-transfer: {units} CU, the plan {} CU", plan.units_consumed);

    let destination = associated_token_account(&setup.to.pubkey(), &mint);
    assert_eq!(token_amount(&setup.svm, &destination), Some(100_000_000));
}

#[test]
fn verifies_a_builder_transfer_with_the_default_checks() {
    let mut setup = setup(TEST_BUILDER_TRANSFER).unwrap();
    let plan = plan(&setup, "test-builder-transfer", &Address::default(), 2 * SOL, &setup.fee_payer.pubkey()).unwrap();
    assert_eq!(verify(&setup.svm, &plan.transaction).unwrap().message, plan.message);

    send_plan(&mut setup.svm, &plan, &[&setup.fee_payer, &setup.from]).unwrap();

    assert_eq!(lamports(&setup.svm, &setup.to.pubkey()), Some(2 * SOL));
}

/// Each segment snapshots and asserts its own transfer, with its own memory.
#[test]
fn verifies_a_plan_of_two_guarded_intents() {
    let mut setup = setup(definitions::SYSTEM_TRANSFER).unwrap();
    let fee_payer = setup.fee_payer.pubkey();
    let first = setup.published.compile(&intent(&setup, "system-transfer", &Address::default(), SOL), &fee_payer);
    let second = setup.published.compile(&intent(&setup, "system-transfer", &Address::default(), 2 * SOL), &fee_payer);

    let plan = prepare_intents(&setup.svm, &[&first.unwrap(), &second.unwrap()]).unwrap();
    assert_eq!(lighthouse_count(&plan), 6);

    send_plan(&mut setup.svm, &plan, &[&setup.fee_payer, &setup.from]).unwrap();

    assert_eq!(lamports(&setup.svm, &setup.to.pubkey()), Some(3 * SOL));
}

/// A looser bound, assertions out of order, and a dropped snapshot each differ from what
/// `verify_intent` builds. A dropped assertion makes the segment end past the transaction.
#[test]
fn refuses_assertions_that_differ_from_the_postconditions() {
    let mut setup = setup(definitions::SYSTEM_TRANSFER).unwrap();
    let plan = plan(&setup, "system-transfer", &Address::default(), 2 * SOL, &setup.fee_payer.pubkey()).unwrap();
    let signers = [&setup.fee_payer, &setup.from];
    let span = plan.intents[0].span.clone();

    let mut looser = plan.clone();
    let bound = &mut looser.transaction.instructions[span.end].data;
    let at = bound.len() - 17;
    bound[at..at + 16].copy_from_slice(&(-10 * i128::from(SOL)).to_le_bytes());
    let failed = send_plan(&mut setup.svm, &looser, &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongAssertions), "{failed}");

    let mut reordered = plan.clone();
    reordered.transaction.instructions.swap(span.end, span.end + 1);
    let failed = send_plan(&mut setup.svm, &reordered, &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongAssertions), "{failed}");

    let mut unchecked = plan.clone();
    unchecked.transaction.instructions.remove(span.end);
    let failed = send_plan(&mut setup.svm, &unchecked, &signers).unwrap_err();
    assert!(failed.is(RegistryError::SpanPastEnd), "{failed}");

    let mut unsnapshot = plan.clone();
    unsnapshot.transaction.instructions.remove(span.start - 1);
    let failed = send_plan(&mut setup.svm, &unsnapshot, &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongAssertions), "{failed}");

    assert!(setup.svm.get_account(&setup.to.pubkey()).is_none());
}

/// The guarded accounts at the end of `verify_intent` must be the accounts that the span can
/// change.
#[test]
fn refuses_guarded_accounts_that_the_span_does_not_change() {
    let mut setup = setup(definitions::SYSTEM_TRANSFER).unwrap();
    let mut plan = plan(&setup, "system-transfer", &Address::default(), 2 * SOL, &setup.fee_payer.pubkey()).unwrap();
    let verify = plan.intents[0].verify.unwrap();

    plan.transaction.instructions[verify].accounts.last_mut().unwrap().address = spec_address(&Keypair::new().pubkey());
    let failed = send_plan(&mut setup.svm, &plan, &[&setup.fee_payer, &setup.from]).unwrap_err();

    assert!(failed.is(RegistryError::WrongGuardedAccounts), "{failed}");
}

/// With `verify_intent` off, nothing checks the built instructions, and the lamport assertion
/// stops a transfer of more than the intent's amount.
#[test]
fn the_assertions_stop_a_larger_transfer_without_verify_intent() {
    let mut setup = setup(definitions::SYSTEM_TRANSFER).unwrap();
    let text = intent(&setup, "system-transfer", &Address::default(), 2 * SOL).replace(
        r#""amount": "2000000000" }"#,
        r#""amount": "2000000000" },
  "options": { "verifyIntent": false }"#,
    );
    let documents = setup.published.compile(&text, &setup.fee_payer.pubkey()).unwrap();
    let plan = prepare(&setup.svm, &documents).unwrap();
    let span = plan.intents[0].span.clone();
    assert_eq!(plan.intents[0].verify, None);

    let mut larger = plan.clone();
    larger.transaction.instructions[span.start].data[4..12].copy_from_slice(&(3 * SOL).to_le_bytes());
    let failed = send_plan(&mut setup.svm, &larger, &[&setup.fee_payer, &setup.from]).unwrap_err();

    assert!(failed.to_string().contains("Program L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95 failed"), "{failed}");
    assert!(setup.svm.get_account(&setup.to.pubkey()).is_none());
}
