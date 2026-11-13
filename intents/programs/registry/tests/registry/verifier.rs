//! The client's verifier on plans that the planner builds: it renders the message from the
//! transaction and the registry, and lists the instructions that no segment holds. The layout that
//! it reads is one that `verify_intent` refuses to lie about.

use anchor_lang::Address;
use anchor_v2_testing::litesvm::LiteSVM;
use anchor_v2_testing::{Keypair, Signer};
use registry::RegistryError;
use sdp_intents_planner::{Plan, VerifyError};
use sdp_intents_program_testing::{definitions, prepare_intents, verify};

use crate::intents::{publish_transfer, spec_address, system_transfer, Published};
use crate::svm::{failure, funded, send_plan, svm, Failure, SOL};

struct Setup {
    svm: LiteSVM,
    published: Published,
    fee_payer: Keypair,
    from: Keypair,
    to: Keypair,
}

fn setup() -> Result<Setup, Failure> {
    let mut svm = svm()?;
    let published = publish_transfer(&mut svm, definitions::SYSTEM_TRANSFER, true)?;
    let fee_payer = funded(&mut svm, SOL)?;
    let from = funded(&mut svm, 10 * SOL)?;

    Ok(Setup { svm, published, fee_payer, from, to: Keypair::new() })
}

fn intent(setup: &Setup, amount: u64, options: &str) -> String {
    format!(
        r#"{{
  "spec": "sdp-intents@1.0",
  "kind": "intent",
  "interface": "solana.org/token.transfer@^1",
  "implementation": "solana.org/system-transfer@^1",
  "inputs": {{ "from": "{}", "to": "{}", "mint": "11111111111111111111111111111111", "amount": "{amount}" }},
  "options": {options}
}}"#,
        setup.from.pubkey(),
        setup.to.pubkey(),
    )
}

fn plan(setup: &Setup, intents: &[(u64, &str)]) -> Result<Plan, Failure> {
    let fee_payer = setup.fee_payer.pubkey();
    let documents = intents
        .iter()
        .map(|(amount, options)| setup.published.compile(&intent(setup, *amount, options), &fee_payer))
        .collect::<Result<Vec<_>, _>>()?;

    prepare_intents(&setup.svm, &documents.iter().collect::<Vec<_>>()).map_err(|error| failure(format!("{error}")))
}

#[test]
fn renders_the_message_of_a_plan_of_two_intents() {
    let setup = setup().unwrap();
    let plan = plan(&setup, &[(SOL, "{}"), (2 * SOL, "{}")]).unwrap();

    let verified = verify(&setup.svm, &plan.transaction).unwrap();

    assert_eq!(verified.message, plan.message);
    let verified_spans: Vec<_> = verified.intents.iter().map(|intent| intent.built.clone()).collect();
    let planned_spans: Vec<_> = plan.intents.iter().map(|intent| intent.span.clone()).collect();
    assert_eq!(verified_spans, planned_spans);
    assert_eq!(verified.intents.iter().map(|intent| intent.verify).collect::<Vec<_>>(), [0, 5]);
    assert_eq!(verified.intents.last().map(|intent| intent.segment.end), Some(plan.transaction.instructions.len()));
    assert!(verified.unverified.is_empty());
}

/// An instruction that no segment holds is listed, and the message stays the same.
#[test]
fn lists_an_instruction_outside_every_segment() {
    let setup = setup().unwrap();
    let mut plan = plan(&setup, &[(SOL, "{}")]).unwrap();
    plan.transaction.instructions.push(system_transfer(&setup.fee_payer.pubkey(), &setup.from.pubkey(), 1));

    let verified = verify(&setup.svm, &plan.transaction).unwrap();

    assert_eq!(verified.message, plan.message);
    assert_eq!(verified.unverified, [plan.transaction.instructions.len() - 1]);
}

/// An intent with `verifyIntent` off proves nothing, so its part of the message is missing and its
/// instructions are listed.
#[test]
fn an_intent_without_verify_intent_is_not_in_the_message() {
    let setup = setup().unwrap();
    let plan = plan(&setup, &[(SOL, "{}"), (2 * SOL, r#"{ "verifyIntent": false }"#)]).unwrap();

    let verified = verify(&setup.svm, &plan.transaction).unwrap();

    assert_ne!(verified.message, plan.message);
    assert_eq!(verified.message.matches(" || ").count(), 1);
    assert_eq!(verified.unverified, (5..plan.transaction.instructions.len()).collect::<Vec<_>>());
}

/// The documents come from the registry's version accounts, so an account in their place that is
/// not one fails.
#[test]
fn refuses_documents_outside_the_registry() {
    let setup = setup().unwrap();
    let mut plan = plan(&setup, &[(SOL, "{}")]).unwrap();
    let verify_position = plan.intents[0].verify.unwrap();
    plan.transaction.instructions[verify_position].accounts[5].address = spec_address(&setup.from.pubkey());

    let refused = verify(&setup.svm, &plan.transaction);

    assert!(matches!(refused, Err(VerifyError::NotAVersion(_))), "{refused:?}");
}

/// The verifier reads the counts of the layout and the outputs, so `verify_intent` refuses ones that
/// differ from what it derives.
#[test]
fn verify_intent_refuses_a_layout_or_outputs_that_lie() {
    let mut setup = setup().unwrap();
    let plan = plan(&setup, &[(SOL, "{}")]).unwrap();
    let signers = [&setup.fee_payer, &setup.from];
    let verify_position = plan.intents[0].verify.unwrap();

    let mut longer = plan.clone();
    let data = &mut longer.transaction.instructions[verify_position].data;
    let built = data.len() - 2;
    data[built] += 1;
    let failed = send_plan(&mut setup.svm, &longer, &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongSegmentLayout), "{failed}");

    let mut other_outputs = plan.clone();
    let data = &mut other_outputs.transaction.instructions[verify_position].data;
    let outputs = data.len() - 12 - 4;
    let layout = data.split_off(outputs + 4);
    data.truncate(outputs);
    data.extend([&32u32.to_le_bytes()[..], &[7; 32], &layout].concat());
    let failed = send_plan(&mut setup.svm, &other_outputs, &signers).unwrap_err();
    assert!(failed.is(RegistryError::WrongOutputs), "{failed}");

    send_plan(&mut setup.svm, &plan, &signers).unwrap();
}

/// The fee payer of every `verify_intent` must be the transaction's.
#[test]
fn refuses_a_transaction_that_another_fee_payer_pays() {
    let setup = setup().unwrap();
    let plan = plan(&setup, &[(SOL, "{}")]).unwrap();
    let mut paid_by_another = plan.transaction.clone();
    paid_by_another.fee_payer = spec_address(&Address::new_unique());

    let refused = verify(&setup.svm, &paid_by_another);

    assert!(matches!(refused, Err(VerifyError::WrongFeePayer(_))), "{refused:?}");
}
