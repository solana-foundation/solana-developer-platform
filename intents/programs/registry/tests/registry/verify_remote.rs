//! `verify_intent` for a remote recipe. Nothing rebuilds the endpoint's instructions, so the tests
//! show what still holds: each program is one that `invokesOnly` lists, each role is what the plan
//! states, and the assertions bound what leaves the sender.

use anchor_v2_testing::{Keypair, Signer};
use registry::RegistryError;
use sdp_intents_planner::{Plan, PlanError, RemoteAnswer};
use sdp_intents_program_testing::prepare_answering;

use crate::intents::{publish_transfer, spec_address, system_transfer, Published};
use crate::svm::{failure, funded, send_plan, svm, Failure, SOL};

/// `token.transfer` of SOL by an endpoint. The record adds the recipient's inflow, because the
/// interface does not promise it, and only the postconditions hold for a remote recipe.
const RECORD: &str = r#"{
  "spec": "sdp-intents@1.0",
  "kind": "implementation",
  "id": "solana.org/remote-transfer",
  "version": "1.0.0",
  "cluster": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  "implements": "solana.org/token.transfer@^1",
  "applies": [{ "value": "{inputs.mint}", "equals": "11111111111111111111111111111111" }],
  "message": "transfer {inputs.amount} of {inputs.mint} from {inputs.from} to {inputs.to} by an endpoint",
  "recipe": { "kind": "remote", "url": "https://example.invalid/transfer", "returns": "instructions" },
  "postConditions": [
    { "invokesOnly": ["11111111111111111111111111111111"], "message": "only System instructions run" },
    { "inflow": { "to": "{inputs.to}", "mint": "{inputs.mint}", "min": "{inputs.amount}" },
      "message": "{inputs.to} receives at least {inputs.amount}" }
  ]
}"#;

const MEMO_PROGRAM: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

struct Setup {
    svm: anchor_v2_testing::litesvm::LiteSVM,
    published: Published,
    fee_payer: Keypair,
    from: Keypair,
    to: Keypair,
}

fn setup() -> Result<Setup, Failure> {
    let mut svm = svm()?;
    let published = publish_transfer(&mut svm, RECORD, true)?;
    let fee_payer = funded(&mut svm, SOL)?;
    let from = funded(&mut svm, 10 * SOL)?;

    Ok(Setup { svm, published, fee_payer, from, to: Keypair::new() })
}

fn intent(setup: &Setup, amount: u64) -> String {
    format!(
        r#"{{
  "spec": "sdp-intents@1.0",
  "kind": "intent",
  "interface": "solana.org/token.transfer@^1",
  "implementation": "solana.org/remote-transfer@^1",
  "inputs": {{ "from": "{}", "to": "{}", "mint": "11111111111111111111111111111111", "amount": "{amount}" }}
}}"#,
        setup.from.pubkey(),
        setup.to.pubkey(),
    )
}

/// The plan of a transfer of `amount`, with `answer` as the endpoint's answer.
fn plan(setup: &Setup, amount: u64, answer: RemoteAnswer) -> Result<Plan, Failure> {
    let documents = setup.published.compile(&intent(setup, amount), &setup.fee_payer.pubkey())?;

    prepare_answering(&setup.svm, &[&documents], vec![answer]).map_err(|error| failure(format!("{error}")))
}

fn honest(setup: &Setup, amount: u64) -> RemoteAnswer {
    RemoteAnswer {
        instructions: vec![system_transfer(&setup.from.pubkey(), &setup.to.pubkey(), amount)],
        outputs: Vec::new(),
    }
}

#[test]
fn lands_an_endpoints_transfer_and_names_its_tier() {
    let mut setup = setup().unwrap();
    let plan = plan(&setup, SOL, honest(&setup, SOL)).unwrap();

    send_plan(&mut setup.svm, &plan, &[&setup.fee_payer, &setup.from]).unwrap();

    assert_eq!(setup.svm.get_balance(&setup.to.pubkey()), Some(SOL));
    assert!(plan.message.contains(" | endpoint: https://example.invalid/transfer | tier 2 | "), "{}", plan.message);
}

/// The planner refuses an answer that cannot meet a postcondition: here no changed account can
/// receive the inflow, so the assertions cannot guard it.
#[test]
fn refuses_an_answer_that_sends_elsewhere() {
    let setup = setup().unwrap();
    let thief = Keypair::new().pubkey();
    let answer =
        RemoteAnswer { instructions: vec![system_transfer(&setup.from.pubkey(), &thief, SOL)], outputs: Vec::new() };

    let refused = plan(&setup, SOL, answer).unwrap_err();

    let names_inflow = refused.error.contains("receives at least") || refused.error.contains("receive the inflow");
    assert!(names_inflow, "{}", refused.error);
}

/// A transaction that calls another program in the built span fails onchain, even when the planner
/// never saw it.
#[test]
fn refuses_a_program_that_invokes_only_does_not_list() {
    let mut setup = setup().unwrap();
    let mut plan = plan(&setup, SOL, honest(&setup, SOL)).unwrap();
    let built = plan.intents[0].span.start;
    plan.transaction.instructions[built].program = spec_address(&MEMO_PROGRAM.parse().unwrap());

    let failed = send_plan(&mut setup.svm, &plan, &[&setup.fee_payer, &setup.from]).unwrap_err();

    assert!(failed.is(RegistryError::ProgramNotListed), "{failed}");
}

/// The assertions bound what leaves the sender, so a larger amount fails onchain.
#[test]
fn the_assertions_refuse_a_larger_amount() {
    let mut setup = setup().unwrap();
    let mut plan = plan(&setup, SOL, honest(&setup, SOL)).unwrap();
    let built = plan.intents[0].span.start;
    plan.transaction.instructions[built] = system_transfer(&setup.from.pubkey(), &setup.to.pubkey(), 2 * SOL);

    let failed = send_plan(&mut setup.svm, &plan, &[&setup.fee_payer, &setup.from]).unwrap_err();

    let lighthouse_failed =
        failed.logs.iter().any(|line| line.starts_with("Program L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95 failed"));
    assert!(lighthouse_failed, "{failed}");
}

#[test]
fn refuses_verify_intent_without_the_assertions() {
    let setup = setup().unwrap();
    let text = intent(&setup, SOL).replace("\"inputs\"", "\"options\": { \"assertions\": false },\n  \"inputs\"");
    let documents = setup.published.compile(&text, &setup.fee_payer.pubkey()).unwrap();

    let refused = prepare_answering(&setup.svm, &[&documents], vec![honest(&setup, SOL)]);

    assert!(matches!(refused, Err(PlanError::RemoteNeedsAssertions)), "{refused:?}");
}
