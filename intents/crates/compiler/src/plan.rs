//! Compiles a plan request: the payers, the cluster, and the priority fee once, then each intent.
//! Each intent compiles to the binary form of an intent document. `cluster` is checked and not
//! stored, because the registry that holds the records is on one cluster.

use sdp_intents_spec::{Address, BaseType, ValueType};
use serde_json::Value;

use crate::borsh::encode;
use crate::catalog::Catalog;
use crate::diagnostic::{Code, Diagnostic, Report};
use crate::encoding::address;
use crate::envelope::{parse_json, read_kind, reported, root};
use crate::intent::{read_intent, CompiledIntent};
use crate::reader::{Node, Object, Sink};

/// A plan request in binary form: its intents, in the order of their segments in the transaction,
/// and what they share.
#[derive(Clone, Debug)]
pub struct CompiledPlan<'c> {
    pub intents: Vec<CompiledIntent<'c>>,
    pub payers: PlanPayers,
    pub priority_fee_lamports: u64,
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
    let priority_fee = object.field("options").map_or(Some(0), |node| read_options(&node, sink));
    read_cluster(&mut object, sink);
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

    Some(CompiledPlan {
        intents: intents.into_iter().collect::<Option<Vec<_>>>()?,
        payers: payers?,
        priority_fee_lamports: priority_fee?,
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

/// The plan's options hold only the total priority fee.
fn read_options(node: &Node<'_>, sink: &mut Sink) -> Option<u64> {
    let mut object = node.object(sink)?;
    let priority_fee = object.field("priorityFeeLamports").map_or(Some(0), |node| {
        let bytes = encode(&node, ValueType { base: BaseType::U64, array: false }, sink)?;

        bytes.try_into().ok().map(u64::from_le_bytes)
    });
    object.finish(sink);

    priority_fee
}

fn read_cluster(object: &mut Object<'_>, sink: &mut Sink) {
    if let Some(cluster) = object.field("cluster") {
        cluster.str(sink).and_then(|text| reported(address(text), &cluster, sink));
    }
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
        assert_eq!(plan.intents[1].implementation.id.name, "system-transfer");
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
