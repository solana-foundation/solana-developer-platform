//! Plans that the planner builds with `verify_intent` in each segment, sent as the planner returns
//! them.

use anchor_v2_testing::litesvm::LiteSVM;
use anchor_v2_testing::{Keypair, Signer};
use sdp_intents_planner::Plan;
use sdp_intents_program_testing::{definitions, prepare, prepare_intents, Documents};

use crate::intents::{builder_roles, publish_transfer, Published};
use crate::svm::{failure, funded, send_plan, svm, Failure, SOL};

const TEST_BUILDER_TRANSFER: &str = include_str!("../../../test-builder/fixtures/test-builder-transfer.json");

struct Wallets {
    fee_payer: Keypair,
    from: Keypair,
    to: Keypair,
}

fn wallets(svm: &mut LiteSVM) -> Result<Wallets, Failure> {
    Ok(Wallets { fee_payer: funded(svm, SOL)?, from: funded(svm, 10 * SOL)?, to: Keypair::new() })
}

/// A transfer of `amount` lamports from `from` to `to`, with `verify_intent` on.
fn intent(implementation: &str, wallets: &Wallets, amount: u64) -> String {
    format!(
        r#"{{
  "spec": "sdp-intents@1.0",
  "kind": "intent",
  "interface": "solana.org/token.transfer@^1",
  "implementation": "solana.org/{implementation}@^1",
  "inputs": {{ "from": "{}", "to": "{}", "mint": "11111111111111111111111111111111", "amount": "{amount}" }},
  "payers": {{ "fee": "{}" }},
  "options": {{ "assertions": false }}
}}"#,
        wallets.from.pubkey(),
        wallets.to.pubkey(),
        wallets.fee_payer.pubkey(),
    )
}

fn verify_at(plan: &Plan, intent: usize) -> Result<&sdp_intents_planner::Instruction, Failure> {
    plan.intents
        .get(intent)
        .and_then(|intent| intent.verify)
        .and_then(|position| plan.transaction.instructions.get(position))
        .ok_or_else(|| failure(format!("intent {intent} has no verify_intent")))
}

#[test]
fn the_planner_builds_the_verify_intent_of_a_client() {
    let mut svm = svm().unwrap();
    let published = publish_transfer(&mut svm, definitions::SYSTEM_TRANSFER, true).unwrap();
    let wallets = wallets(&mut svm).unwrap();
    let documents = published.compile(&intent("system-transfer", &wallets, SOL)).unwrap();

    let plan = prepare(&svm, &documents).unwrap();
    let by_hand = published.verify_instruction(&svm, &documents, &[], &[]).unwrap();

    assert_eq!(verify_at(&plan, 0).unwrap(), &by_hand);
    assert_eq!(plan.intents[0].span, 1..2);
}

/// Each `verify_intent` covers the one transfer after it, so the second `verify_intent` is outside
/// the first one's span.
#[test]
fn verifies_a_plan_of_two_intents() {
    let mut svm = svm().unwrap();
    let published = publish_transfer(&mut svm, definitions::SYSTEM_TRANSFER, true).unwrap();
    let wallets = wallets(&mut svm).unwrap();
    let first = published.compile(&intent("system-transfer", &wallets, SOL)).unwrap();
    let second = published.compile(&intent("system-transfer", &wallets, 2 * SOL)).unwrap();

    let plan = prepare_intents(&svm, &[first.as_intent(), second.as_intent()]).unwrap();
    let spans: Vec<_> = plan.intents.iter().map(|intent| (intent.verify, intent.span.clone())).collect();
    assert_eq!(spans, [(Some(0), 1..2), (Some(2), 3..4)]);

    send_plan(&mut svm, &plan, &[&wallets.fee_payer, &wallets.from]).unwrap();

    assert_eq!(svm.get_account(&wallets.to.pubkey()).map(|account| account.lamports), Some(3 * SOL));
}

/// The planner passes the accounts of the builder's last round, and the builder's roles.
#[test]
fn verifies_a_builder_that_the_planner_planned() {
    let mut svm = svm().unwrap();
    let published: Published = publish_transfer(&mut svm, TEST_BUILDER_TRANSFER, true).unwrap();
    let wallets = wallets(&mut svm).unwrap();
    let documents: Documents = published.compile(&intent("test-builder-transfer", &wallets, 2 * SOL)).unwrap();

    let plan = prepare(&svm, &documents).unwrap();
    let span = plan.intents[0].span.clone();
    let built = Plan {
        transaction: sdp_intents_planner::Transaction {
            instructions: plan.transaction.instructions[span].to_vec(),
            ..plan.transaction.clone()
        },
        ..plan.clone()
    };
    let by_hand =
        published.verify_instruction(&svm, &documents, &[test_builder::EXTRA_ACCOUNT], &builder_roles(&built)).unwrap();
    assert_eq!(verify_at(&plan, 0).unwrap(), &by_hand);

    send_plan(&mut svm, &plan, &[&wallets.fee_payer, &wallets.from]).unwrap();

    assert_eq!(svm.get_account(&wallets.to.pubkey()).map(|account| account.lamports), Some(2 * SOL));
}
