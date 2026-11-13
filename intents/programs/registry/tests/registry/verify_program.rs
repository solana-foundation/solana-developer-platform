//! `verify_intent` for a program recipe: the test builder asks for one account in its first round,
//! so the plan takes two builder simulations. `verify_intent` passes that account, calls the
//! builder in hashed mode, and compares the hash with the transaction's instructions.

use anchor_v2_testing::{Keypair, Signer};
use registry::RegistryError;
use sdp_intents_planner::Plan;
use sdp_intents_program_testing::prepare;

use crate::intents::{builder_roles, built_count, publish_transfer, unguarded, with_verify, Published};
use crate::svm::{failure, funded, send_plan, svm, units_consumed, Failure, SOL};

const RECORD: &str = include_str!("../../../test-builder/fixtures/test-builder-transfer.json");

/// `BuildError::MissingAccounts` of the builder library.
const BUILDER_MISSING_ACCOUNTS: u32 = 0x5d1b_0003;

struct Setup {
    svm: anchor_v2_testing::litesvm::LiteSVM,
    published: Published,
    fee_payer: Keypair,
    from: Keypair,
    to: Keypair,
}

fn intent(setup: &Setup, amount: u64, options: &str) -> String {
    format!(
        r#"{{
  "spec": "sdp-intents@1.0",
  "kind": "intent",
  "interface": "solana.org/token.transfer@^1",
  "implementation": "solana.org/test-builder-transfer@^1",
  "inputs": {{ "from": "{}", "to": "{}", "mint": "11111111111111111111111111111111", "amount": "{amount}" }},
  "options": {options}
}}"#,
        setup.from.pubkey(),
        setup.to.pubkey(),
    )
}

fn setup() -> Result<Setup, Failure> {
    let mut svm = svm()?;
    let published = publish_transfer(&mut svm, RECORD, true)?;
    let fee_payer = funded(&mut svm, SOL)?;
    let from = funded(&mut svm, 10 * SOL)?;

    Ok(Setup { svm, published, fee_payer, from, to: Keypair::new() })
}

/// The two-round plan, and `verify_intent` with the account of the last round when `extra` is set.
fn plan_and_verify(setup: &Setup, amount: u64, extra: bool) -> Result<Plan, Failure> {
    plan_and_verify_with_roles(setup, amount, extra, None)
}

/// `plan_and_verify`, with `roles` in place of the builder's roles in `verify_intent` when set.
fn plan_and_verify_with_roles(setup: &Setup, amount: u64, extra: bool, roles: Option<&[u8]>) -> Result<Plan, Failure> {
    let planned = setup.published.compile(
        &intent(setup, amount, r#"{ "assertions": false, "verifyIntent": false }"#),
        &setup.fee_payer.pubkey(),
    )?;
    let verified =
        setup.published.compile(&intent(setup, amount, r#"{ "assertions": false }"#), &setup.fee_payer.pubkey())?;
    let plan = prepare(&setup.svm, &planned).map_err(|error| failure(format!("{error}")))?;

    let builder_simulations: usize = plan.intents.iter().map(|intent| intent.builder_simulations).sum();

    if builder_simulations != 2 {
        return Err(failure(format!("the plan took {builder_simulations} builder simulations")));
    }

    let extra_accounts = if extra { vec![test_builder::EXTRA_ACCOUNT] } else { Vec::new() };
    let roles = roles.map_or_else(|| builder_roles(&plan), <[u8]>::to_vec);
    let layout = unguarded(built_count(&plan), 0);
    let verify = setup.published.verify_instruction(&setup.svm, &verified, &extra_accounts, &roles, layout)?;

    Ok(with_verify(&plan, verify))
}

/// The hash covers the builder's roles, so roles that the builder did not write fail it, and a
/// count that does not match the accounts fails first.
#[test]
fn refuses_builder_roles_that_the_builder_did_not_write() {
    let mut setup = setup().unwrap();
    let lying = plan_and_verify_with_roles(&setup, 2 * SOL, true, Some(&[3, 3])).unwrap();
    let short = plan_and_verify_with_roles(&setup, 2 * SOL, true, Some(&[3])).unwrap();
    let signers = [&setup.fee_payer, &setup.from];

    let failed = send_plan(&mut setup.svm, &lying, &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongInstructionsHash), "{failed}");

    let failed = send_plan(&mut setup.svm, &short, &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongBuilderRoles), "{failed}");
}

#[test]
fn verifies_a_two_round_builder_transfer() {
    let mut setup = setup().unwrap();
    let plan = plan_and_verify(&setup, 2 * SOL, true).unwrap();

    let sent = send_plan(&mut setup.svm, &plan, &[&setup.fee_payer, &setup.from]).unwrap();
    let units = units_consumed(&sent.logs, &registry::ID).unwrap();
    println!("verify_intent, test-builder-transfer: {units} CU");

    assert_eq!(setup.svm.get_account(&setup.to.pubkey()).map(|account| account.lamports), Some(2 * SOL));
    assert!(units < 25_000, "verify_intent used {units} CU");
}

#[test]
fn refuses_instructions_that_differ_from_the_builder() {
    let mut setup = setup().unwrap();
    let plan = plan_and_verify(&setup, 2 * SOL, true).unwrap();
    let signers = [&setup.fee_payer, &setup.from];

    let mut more = plan.clone();
    more.transaction.instructions[1].data[4..12].copy_from_slice(&(3 * SOL).to_le_bytes());
    let failed = send_plan(&mut setup.svm, &more, &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongInstructionsHash), "{failed}");

    let mut removed = plan.clone();
    removed.transaction.instructions.pop();
    let failed = send_plan(&mut setup.svm, &removed, &[&setup.fee_payer]).unwrap_err();
    assert!(failed.is(RegistryError::SpanPastEnd), "{failed}");

    assert!(setup.svm.get_account(&setup.to.pubkey()).is_none());
}

#[test]
fn the_builder_fails_without_the_accounts_of_its_last_round() {
    let mut setup = setup().unwrap();
    let plan = plan_and_verify(&setup, SOL, false).unwrap();

    let failed = send_plan(&mut setup.svm, &plan, &[&setup.fee_payer, &setup.from]).unwrap_err();

    assert_eq!(failed.custom_code(), Some(BUILDER_MISSING_ACCOUNTS), "{failed}");
}
