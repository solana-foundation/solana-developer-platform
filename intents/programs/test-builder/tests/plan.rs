//! The planner against the test builder in LiteSVM: two builder rounds, the final simulation and its
//! checks, then the plan's transaction, signed and sent.

use anchor_v2_testing::litesvm::LiteSVM;
use anchor_v2_testing::{Keypair, Signer};
use sdp_intents_planner::PlanError;
use sdp_intents_program_testing::{built, definitions, prepare, send, svm, Documents};

const RECORD: &str = include_str!("../fixtures/test-builder-transfer.json");
const PROGRAM: &[u8] = include_bytes!("../../target/deploy/test_builder.so");
const SOL: u64 = 1_000_000_000;

struct Wallets {
    fee_payer: Keypair,
    from: Keypair,
    to: Keypair,
}

struct Setup {
    svm: LiteSVM,
    wallets: Wallets,
}

fn setup() -> Result<Setup, String> {
    let mut svm = svm()?;
    svm.add_program(test_builder::id(), PROGRAM).map_err(|error| format!("{error:?}"))?;

    let wallets = Wallets { fee_payer: Keypair::new(), from: Keypair::new(), to: Keypair::new() };
    svm.airdrop(&wallets.fee_payer.pubkey(), SOL).map_err(|failed| format!("{:?}", failed.err))?;
    svm.airdrop(&wallets.from.pubkey(), 10 * SOL).map_err(|failed| format!("{:?}", failed.err))?;

    Ok(Setup { svm, wallets })
}

fn intent(wallets: &Wallets, amount: u64) -> String {
    format!(
        r#"{{
  "spec": "sdp-intents@1.0",
  "kind": "intent",
  "interface": "solana.org/token.transfer@^1",
  "implementation": "solana.org/test-builder-transfer@^1",
  "inputs": {{ "from": "{}", "to": "{}", "mint": "11111111111111111111111111111111", "amount": "{amount}" }},
  "options": {{ "verifyIntent": false }}
}}"#,
        wallets.from.pubkey(),
        wallets.to.pubkey(),
    )
}

#[test]
fn plans_a_builder_transfer_in_two_rounds_and_sends_it() {
    let Setup { mut svm, wallets } = setup().unwrap();
    let documents = Documents::compile(
        &[definitions::TOKEN_TRANSFER],
        &[RECORD],
        &intent(&wallets, 2 * SOL),
        &wallets.fee_payer.pubkey(),
    )
    .unwrap();

    let plan = prepare(&svm, &documents).unwrap();

    assert_eq!(plan.intents[0].builder_simulations, 2);
    assert_eq!(built(&plan).len(), 1);
    assert!(plan.message.contains(&format!(" || 1: transfer 2 SOL from {}", wallets.from.pubkey())));
    assert!(plan.message.contains("@1.0.0 | tier 1 | onchain checks: assertions | rent cap "));
    assert_eq!(plan.intents[0].builder.map(|program| program.0), Some(test_builder::id().to_bytes()));

    send(&mut svm, &plan, &[&wallets.fee_payer, &wallets.from]).unwrap();

    assert_eq!(svm.get_account(&wallets.to.pubkey()).map(|account| account.lamports), Some(2 * SOL));
}

#[test]
fn a_refusal_ends_the_plan() {
    let Setup { svm, wallets } = setup().unwrap();
    let documents = Documents::compile(
        &[definitions::TOKEN_TRANSFER],
        &[RECORD],
        &intent(&wallets, 0),
        &wallets.fee_payer.pubkey(),
    )
    .unwrap();

    let refused = prepare(&svm, &documents);

    assert_eq!(
        refused.err(),
        Some(PlanError::Refused { code: "zeroAmount".into(), message: "the amount is zero".into() })
    );
}

#[test]
fn a_transfer_of_more_than_the_sender_holds_fails_the_simulation() {
    let Setup { svm, wallets } = setup().unwrap();
    let documents = Documents::compile(
        &[definitions::TOKEN_TRANSFER],
        &[RECORD],
        &intent(&wallets, 20 * SOL),
        &wallets.fee_payer.pubkey(),
    )
    .unwrap();

    let failed = prepare(&svm, &documents);

    assert!(matches!(failed, Err(PlanError::Simulation { .. })));
}
