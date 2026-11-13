//! Compiles a plan request: the payers, the cluster, and the priority fee once, then each intent.
//! Each intent compiles to the binary form of an intent document. `cluster` is a name, such as
//! `mainnet`, or a genesis hash. It is not stored, and each record must be for it.

use sdp_intents_spec::{Address, BaseType, ValueType};
use serde_json::Value;

use crate::borsh::encode;
use crate::catalog::Catalog;
use crate::diagnostic::{Code, Diagnostic, Report};
use crate::encoding::address;
use crate::envelope::{parse_json, read_kind, reported, root};
use crate::implementation::read_cluster;
use crate::intent::{read_intent, CompiledIntent};
use crate::reader::{Node, Sink};

/// A plan request in binary form: its intents, in the order of their segments in the transaction,
/// and what they share.
#[derive(Clone, Debug)]
pub struct CompiledPlan<'c> {
    pub intents: Vec<CompiledIntent<'c>>,
    pub payers: PlanPayers,
    pub priority_fee_lamports: u64,
    pub output: PlanOutput,
}

/// What `prepare` returns: a compiled v1 transaction, or the instructions alone for a caller that
/// compiles its own transaction, of any version.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PlanOutput {
    #[default]
    Transaction,
    Instructions,
}

/// The plan's options.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PlanOptions {
    priority_fee_lamports: u64,
    output: PlanOutput,
}

/// `rent` defaults to `fee`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlanPayers {
    pub fee: Address,
    pub rent: Address,
}

pub(crate) fn compile_plan<'c>(text: &str, catalog: &'c Catalog) -> Result<CompiledPlan<'c>, Report> {
    let value = parse_json(text)?;
    let mut sink = Sink::default();
    let compiled = compile(&value, catalog, &mut sink);

    match compiled {
        Some(compiled) if sink.is_empty() => Ok(compiled),
        _ => Err(Report { diagnostics: sink.into_diagnostics(), syntax: None }),
    }
}

fn compile<'c>(value: &Value, catalog: &'c Catalog, sink: &mut Sink) -> Option<CompiledPlan<'c>> {
    let mut object = root(value, sink)?;
    read_kind(&mut object, "plan", sink);

    let payers = object.required("payers", sink).and_then(|node| read_payers(&node, sink));
    let options = object.field("options").map_or(Some(PlanOptions::default()), |node| read_options(&node, sink));
    let cluster = object.field("cluster").map(|node| (read_cluster(&node, sink), node.pointer.clone()));
    let entries = object.required("intents", sink).and_then(|node| node.array(sink));
    let pointer = format!("{}/intents", object.pointer());
    object.finish(sink);

    let entries = entries?;

    if entries.is_empty() {
        sink.push(Diagnostic::new(Code::InvalidValue, &pointer, "a plan holds at least one intent"));
    }

    let intents: Vec<Option<CompiledIntent<'c>>> = entries
        .iter()
        .map(|node| {
            let mut entry = node.object(sink)?;
            let intent = read_intent(&mut entry, catalog, sink);
            entry.finish(sink);

            intent
        })
        .collect();

    if let Some((Some(cluster), pointer)) = cluster {
        check_cluster(&cluster, &intents, &pointer, sink);
    }

    Some(CompiledPlan {
        intents: intents.into_iter().collect::<Option<Vec<_>>>()?,
        payers: payers?,
        priority_fee_lamports: options?.priority_fee_lamports,
        output: options?.output,
    })
}

fn read_payers(node: &Node<'_>, sink: &mut Sink) -> Option<PlanPayers> {
    let mut object = node.object(sink)?;
    let read = |node: Node<'_>, sink: &mut Sink| node.str(sink).and_then(|text| reported(address(text), &node, sink));

    let fee = object.required("fee", sink).and_then(|node| read(node, sink)).map(Address);
    let rent = object.field("rent").map(|node| read(node, sink).map(Address));
    object.finish(sink);

    let fee = fee?;

    Some(PlanPayers { fee, rent: rent.unwrap_or(Some(fee))? })
}

/// The total priority fee, and what `prepare` returns.
fn read_options(node: &Node<'_>, sink: &mut Sink) -> Option<PlanOptions> {
    let mut object = node.object(sink)?;
    let priority_fee = object.field("priorityFeeLamports").map_or(Some(0), |node| {
        let bytes = encode(&node, ValueType { base: BaseType::U64, array: false }, sink)?;

        bytes.try_into().ok().map(u64::from_le_bytes)
    });
    let output = object.field("output").map_or(Some(PlanOutput::Transaction), |node| match node.str(sink)? {
        "transaction" => Some(PlanOutput::Transaction),
        "instructions" => Some(PlanOutput::Instructions),
        _ => {
            sink.push(Diagnostic::new(
                Code::InvalidValue,
                &node.pointer,
                "`output` is `transaction` or `instructions`",
            ));
            None
        }
    });
    object.finish(sink);

    Some(PlanOptions { priority_fee_lamports: priority_fee?, output: output? })
}

/// Each record of the plan must be for the plan's cluster.
fn check_cluster(cluster: &Address, intents: &[Option<CompiledIntent<'_>>], pointer: &str, sink: &mut Sink) {
    let name = |hash: &Address| sdp_intents_spec::cluster::name(hash).map_or_else(|| bs58_text(hash), str::to_owned);
    let other = intents.iter().flatten().find_map(|intent| {
        let record = sdp_intents_spec::Implementation::parse(&intent.implementation.bytes).ok()?;

        (record.cluster() != cluster).then(|| (intent.implementation.id.to_string(), *record.cluster()))
    });

    if let Some((id, record_cluster)) = other {
        sink.push(Diagnostic::new(
            Code::InvalidValue,
            pointer,
            format!("the plan is for {}, and `{id}` is for {}", name(cluster), name(&record_cluster)),
        ));
    }
}

fn bs58_text(address: &Address) -> String {
    bs58::encode(address.0).into_string()
}

#[cfg(test)]
mod tests {
    use sdp_intents_spec::Intent;

    use super::*;
    use crate::test_support::{edit, full_catalog};

    const PLAN: &str = include_str!("../../../fixtures/plans/mainnet/usdc-and-sol-transfers.json");

    #[test]
    fn the_plan_holds_the_payers_and_the_priority_fee() {
        let catalog = full_catalog();
        let plan = compile_plan(PLAN, &catalog).unwrap();

        assert_eq!(plan.intents.len(), 2);
        assert_eq!(plan.payers.fee, plan.payers.rent);
        assert_eq!(plan.priority_fee_lamports, 5_000);
        assert_eq!(plan.output, PlanOutput::Transaction);
        assert_eq!(plan.intents[1].implementation.id.name, "system-transfer");
    }

    /// A cluster is a name or a genesis hash, and every record must be for it.
    #[test]
    fn every_record_is_for_the_plan_cluster() {
        let catalog = full_catalog();
        let named =
            edit(PLAN, "\"cluster\": \"5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d\"", "\"cluster\": \"mainnet\"");
        let devnet =
            edit(PLAN, "\"cluster\": \"5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d\"", "\"cluster\": \"devnet\"");
        let report = compile_plan(&devnet, &catalog).unwrap_err();

        assert!(compile_plan(&named, &catalog).is_ok());
        assert!(report.diagnostics.iter().any(|finding| finding.message.contains("is for devnet")), "{report:?}");
        assert!(report.diagnostics.iter().any(|finding| finding.message.contains("is for mainnet")), "{report:?}");
    }

    #[test]
    fn the_plan_can_ask_for_its_instructions_alone() {
        let catalog = full_catalog();
        let options = |output: &str| {
            edit(
                PLAN,
                "\"priorityFeeLamports\": \"5000\"",
                &format!("\"priorityFeeLamports\": \"5000\", \"output\": \"{output}\""),
            )
        };

        assert_eq!(compile_plan(&options("instructions"), &catalog).unwrap().output, PlanOutput::Instructions);
        assert!(compile_plan(&options("bytes"), &catalog).is_err());
    }

    #[test]
    fn an_intent_turns_off_its_own_checks() {
        let text = edit(
            PLAN,
            r#""amount": "250000000"
      },
      "options": { "verifyIntent": false }"#,
            r#""amount": "250000000"
      }"#,
        );
        let catalog = full_catalog();
        let plan = compile_plan(&text, &catalog).unwrap();
        let verifies =
            |index: usize| Intent::parse(&plan.intents[index].bytes).unwrap().options().unwrap().verify_intent;

        assert!(!verifies(0));
        assert!(verifies(1));
    }

    #[test]
    fn refuses_an_empty_plan_and_payers_in_an_intent() {
        let empty = r#"{ "spec": "sdp-intents@1.0", "kind": "plan", "payers": { "fee": "11111111111111111111111111111111" }, "intents": [] }"#;
        let report = compile_plan(empty, &full_catalog()).unwrap_err();
        assert_eq!(report.codes(), [Code::InvalidValue]);

        let own_payers = edit(
            PLAN,
            r#""memo": null
      },"#,
            r#""memo": null
      },
      "payers": { "fee": "11111111111111111111111111111111" },"#,
        );
        let report = compile_plan(&own_payers, &full_catalog()).unwrap_err();
        assert_eq!(report.codes(), [Code::UnknownKey]);
    }
}
