//! `verify_intent` for static recipes: the planner plans with `verifyIntent` off, the test puts
//! `verify_intent` first, and the transaction lands only when the instructions are the record's.

use anchor_lang::Address;
use anchor_v2_testing::litesvm::LiteSVM;
use anchor_v2_testing::{Keypair, Signer};
use registry::RegistryError;
use sdp_intents_planner::Plan;
use sdp_intents_program_testing::{definitions, prepare};

use crate::intents::{publish_transfer, with_verify, Published};
use crate::svm::{funded, send_plan, svm, units_consumed, Failure, SOL};
use crate::token::{associated_token_account, set_mint, set_token_account, token_amount};

/// The options of the intent that the planner takes, and of the one in `verify_intent`.
const PLANNED: &str = r#"{ "assertions": false, "verifyIntent": false }"#;
const VERIFIED: &str = r#"{ "assertions": false }"#;

struct Wallets {
    fee_payer: Keypair,
    from: Keypair,
    to: Keypair,
}

struct Setup {
    svm: LiteSVM,
    published: Published,
    wallets: Wallets,
}

fn setup(implementation: &'static str, approve: bool) -> Result<Setup, Failure> {
    let mut svm = svm()?;
    let published = publish_transfer(&mut svm, implementation, approve)?;
    let wallets = Wallets { fee_payer: funded(&mut svm, SOL)?, from: funded(&mut svm, 10 * SOL)?, to: Keypair::new() };

    Ok(Setup { svm, published, wallets })
}

fn intent(implementation: &str, wallets: &Wallets, mint: &Address, amount: u64, options: &str) -> String {
    format!(
        r#"{{
  "spec": "sdp-intents@1.0",
  "kind": "intent",
  "interface": "solana.org/token.transfer@^1",
  "implementation": "solana.org/{implementation}@^1",
  "inputs": {{ "from": "{}", "to": "{}", "mint": "{mint}", "amount": "{amount}" }},
  "payers": {{ "fee": "{}" }},
  "options": {options}
}}"#,
        wallets.from.pubkey(),
        wallets.to.pubkey(),
        wallets.fee_payer.pubkey(),
    )
}

/// The plan of the intent, and `verify_intent` for the same intent with the check on.
struct Verified {
    plan: Plan,
    verify: sdp_intents_planner::Instruction,
}

fn plan_and_verify(setup: &Setup, implementation: &str, mint: &Address, amount: u64) -> Result<Verified, Failure> {
    let planned = setup.published.compile(&intent(implementation, &setup.wallets, mint, amount, PLANNED))?;
    let verified = setup.published.compile(&intent(implementation, &setup.wallets, mint, amount, VERIFIED))?;
    let plan = prepare(&setup.svm, &planned).map_err(|error| crate::svm::failure(format!("{error}")))?;
    let verify = setup.published.verify_instruction(&setup.svm, &verified, &[], &[])?;

    Ok(Verified { plan, verify })
}

fn system_program() -> Address {
    crate::client::system_program()
}

#[test]
fn verifies_a_system_transfer() {
    let mut setup = setup(definitions::SYSTEM_TRANSFER, true).unwrap();
    let verified = plan_and_verify(&setup, "system-transfer", &system_program(), 2 * SOL).unwrap();
    let signers = [&setup.wallets.fee_payer, &setup.wallets.from];

    let sent = send_plan(&mut setup.svm, &with_verify(&verified.plan, verified.verify), &signers).unwrap();
    let units = units_consumed(&sent.logs, &registry::ID).unwrap();
    println!("verify_intent, system-transfer: {units} CU");

    assert_eq!(setup.svm.get_account(&setup.wallets.to.pubkey()).map(|account| account.lamports), Some(2 * SOL));
    assert!(units < 15_000, "verify_intent used {units} CU");
}

#[test]
fn refuses_a_system_transfer_of_another_amount_or_to_another_wallet() {
    let mut setup = setup(definitions::SYSTEM_TRANSFER, true).unwrap();
    let verified = plan_and_verify(&setup, "system-transfer", &system_program(), 2 * SOL).unwrap();
    let signers = [&setup.wallets.fee_payer, &setup.wallets.from];

    let mut more = verified.plan.clone();
    more.transaction.instructions[0].data[4..12].copy_from_slice(&(3 * SOL).to_le_bytes());
    let failed = send_plan(&mut setup.svm, &with_verify(&more, verified.verify.clone()), &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongInstruction), "{failed}");

    let mut elsewhere = verified.plan.clone();
    elsewhere.transaction.instructions[0].accounts[1].address = sdp_intents_spec::Address([9; 32]);
    let failed = send_plan(&mut setup.svm, &with_verify(&elsewhere, verified.verify.clone()), &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongInstruction), "{failed}");

    let mut added = verified.plan.clone();
    added.transaction.instructions.push(verified.plan.transaction.instructions[0].clone());
    let failed = send_plan(&mut setup.svm, &with_verify(&added, verified.verify), &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongInstructionCount), "{failed}");

    assert!(setup.svm.get_account(&setup.wallets.to.pubkey()).is_none());
}

#[test]
fn verify_intent_must_come_before_the_built_instructions() {
    let mut setup = setup(definitions::SYSTEM_TRANSFER, true).unwrap();
    let verified = plan_and_verify(&setup, "system-transfer", &system_program(), SOL).unwrap();
    let signers = [&setup.wallets.fee_payer, &setup.wallets.from];

    let mut last = verified.plan.clone();
    last.transaction.instructions.push(verified.verify);
    last.transaction.budget = sdp_intents_planner::Budget::MAXIMUM;
    let failed = send_plan(&mut setup.svm, &last, &signers).unwrap_err();

    assert!(failed.is(RegistryError::UnverifiedInstruction), "{failed}");
}

#[test]
fn refuses_an_unapproved_implementation_unless_the_intent_allows_it() {
    let mut setup = setup(definitions::SYSTEM_TRANSFER, false).unwrap();
    let verified = plan_and_verify(&setup, "system-transfer", &system_program(), SOL).unwrap();
    let signers = [&setup.wallets.fee_payer, &setup.wallets.from];

    let failed = send_plan(&mut setup.svm, &with_verify(&verified.plan, verified.verify), &signers).unwrap_err();
    assert!(failed.is(RegistryError::NotApproved), "{failed}");

    let allowing = |options: &str| options.replace("{ ", r#"{ "allowUnapproved": true, "#);
    let to = intent("system-transfer", &setup.wallets, &system_program(), SOL, &allowing(PLANNED));
    let planned = setup.published.compile(&to).unwrap();
    let verified = setup
        .published
        .compile(&intent("system-transfer", &setup.wallets, &system_program(), SOL, &allowing(VERIFIED)))
        .unwrap();
    let plan = prepare(&setup.svm, &planned).unwrap();
    let verify = setup.published.verify_instruction(&setup.svm, &verified, &[], &[]).unwrap();

    send_plan(&mut setup.svm, &with_verify(&plan, verify), &signers).unwrap();
}

#[test]
fn refuses_an_intent_that_turns_verification_off() {
    let mut setup = setup(definitions::SYSTEM_TRANSFER, true).unwrap();
    let planned =
        setup.published.compile(&intent("system-transfer", &setup.wallets, &system_program(), SOL, PLANNED)).unwrap();
    let plan = prepare(&setup.svm, &planned).unwrap();
    let verify = setup.published.verify_instruction(&setup.svm, &planned, &[], &[]).unwrap();
    let signers = [&setup.wallets.fee_payer, &setup.wallets.from];

    let failed = send_plan(&mut setup.svm, &with_verify(&plan, verify), &signers).unwrap_err();

    assert!(failed.is(RegistryError::VerificationOff), "{failed}");
}

#[test]
fn refuses_registry_and_record_accounts_that_do_not_fit_the_intent() {
    let mut setup = setup(definitions::SYSTEM_TRANSFER, true).unwrap();
    let verified = plan_and_verify(&setup, "system-transfer", &system_program(), SOL).unwrap();
    let signers = [&setup.wallets.fee_payer, &setup.wallets.from];

    let mut other_recipient = verified.verify.clone();
    other_recipient.accounts[6].address = sdp_intents_spec::Address([9; 32]);
    let failed = send_plan(&mut setup.svm, &with_verify(&verified.plan, other_recipient), &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongRecipeAccount), "{failed}");

    let mut swapped_indexes = verified.verify.clone();
    swapped_indexes.accounts.swap(1, 2);
    let failed = send_plan(&mut setup.svm, &with_verify(&verified.plan, swapped_indexes), &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongIndexKind), "{failed}");

    let mut swapped_versions = verified.verify;
    swapped_versions.accounts.swap(3, 4);
    let failed = send_plan(&mut setup.svm, &with_verify(&verified.plan, swapped_versions), &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongAccount), "{failed}");
}

/// An SPL Token mint, the sender's token account, and the receiver's token account address.
struct TokenAccounts {
    mint: Address,
    source: Address,
    destination: Address,
}

fn token_accounts(setup: &mut Setup) -> Result<TokenAccounts, Failure> {
    let mint = Keypair::new().pubkey();
    let source = associated_token_account(&setup.wallets.from.pubkey(), &mint);
    set_mint(&mut setup.svm, &mint, 6)?;
    set_token_account(&mut setup.svm, &source, &mint, &setup.wallets.from.pubkey(), 500_000_000)?;

    Ok(TokenAccounts { mint, source, destination: associated_token_account(&setup.wallets.to.pubkey(), &mint) })
}

#[test]
fn verifies_an_spl_token_transfer() {
    let mut setup = setup(definitions::SPL_TOKEN_TRANSFER, true).unwrap();
    let tokens = token_accounts(&mut setup).unwrap();
    let verified = plan_and_verify(&setup, "spl-token-transfer", &tokens.mint, 100_000_000).unwrap();
    let signers = [&setup.wallets.fee_payer, &setup.wallets.from];

    let sent = send_plan(&mut setup.svm, &with_verify(&verified.plan, verified.verify), &signers).unwrap();
    let units = units_consumed(&sent.logs, &registry::ID).unwrap();
    println!("verify_intent, spl-token-transfer: {units} CU");

    assert_eq!(token_amount(&setup.svm, &tokens.destination), Some(100_000_000));
    assert_eq!(token_amount(&setup.svm, &tokens.source), Some(400_000_000));
    assert!(units < 30_000, "verify_intent used {units} CU");
}

#[test]
fn refuses_an_spl_token_transfer_with_other_decimals() {
    let mut setup = setup(definitions::SPL_TOKEN_TRANSFER, true).unwrap();
    let tokens = token_accounts(&mut setup).unwrap();
    let verified = plan_and_verify(&setup, "spl-token-transfer", &tokens.mint, 100_000_000).unwrap();
    let signers = [&setup.wallets.fee_payer, &setup.wallets.from];

    let mut tampered = verified.plan.clone();
    *tampered.transaction.instructions[1].data.last_mut().unwrap() = 9;
    let failed = send_plan(&mut setup.svm, &with_verify(&tampered, verified.verify.clone()), &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongInstruction), "{failed}");

    let mut readonly_destination = verified.plan.clone();
    readonly_destination.transaction.instructions[1].accounts[2].role = sdp_intents_spec::AccountRole::Readonly;
    readonly_destination.transaction.instructions[0].accounts[1].role = sdp_intents_spec::AccountRole::Readonly;
    let failed = send_plan(&mut setup.svm, &with_verify(&readonly_destination, verified.verify), &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongRole), "{failed}");
}

/// The transfer names the sender as a readonly signer, and the fee payer slot makes it a writable
/// signer in the whole transaction. The union of the two explains the role.
#[test]
fn verifies_an_spl_token_transfer_whose_sender_pays_the_fee() {
    let mut setup = setup(definitions::SPL_TOKEN_TRANSFER, true).unwrap();
    setup.wallets.fee_payer = setup.wallets.from.insecure_clone();
    let tokens = token_accounts(&mut setup).unwrap();
    let verified = plan_and_verify(&setup, "spl-token-transfer", &tokens.mint, 100_000_000).unwrap();

    send_plan(&mut setup.svm, &with_verify(&verified.plan, verified.verify), &[&setup.wallets.from]).unwrap();

    assert_eq!(token_amount(&setup.svm, &tokens.destination), Some(100_000_000));
}

/// The receiver pays the transaction's fee, so it is a writable signer, and no built instruction or
/// the intent's fee payer explains that role.
#[test]
fn refuses_a_role_that_no_built_instruction_explains() {
    let mut setup = setup(definitions::SPL_TOKEN_TRANSFER, true).unwrap();
    let tokens = token_accounts(&mut setup).unwrap();
    let verified = plan_and_verify(&setup, "spl-token-transfer", &tokens.mint, 100_000_000).unwrap();
    setup.svm.airdrop(&setup.wallets.to.pubkey(), SOL).unwrap();

    let mut paid_by_receiver = with_verify(&verified.plan, verified.verify);
    paid_by_receiver.transaction.fee_payer = sdp_intents_spec::Address(setup.wallets.to.pubkey().to_bytes());
    let signers = [&setup.wallets.to, &setup.wallets.from, &setup.wallets.fee_payer];
    let failed = send_plan(&mut setup.svm, &paid_by_receiver, &signers).unwrap_err();

    assert!(failed.is(RegistryError::WrongRole), "{failed}");
}
