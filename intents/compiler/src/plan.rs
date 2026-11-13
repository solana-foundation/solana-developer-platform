//! Compiles a plan request: the payers, the cluster, and the priority fee once, then each intent's
//! documents, inputs, and options. Each intent compiles to the same binary form as an intent
//! document, with the plan's payers and priority fee.

use serde_json::Value;

use crate::catalog::Catalog;
use crate::diagnostic::{Code, Diagnostic, Report};
use crate::envelope::{parse_json, read_kind, root};
use crate::intent::{
    read_cluster, read_entry, read_flags, read_payers, read_priority_fee, write_intent, CompiledIntent, Terms,
};
use crate::reader::{Node, Sink};

/// The intents of a plan, in the order of their segments in the transaction.
#[derive(Clone, Debug)]
pub struct CompiledPlan<'c> {
    pub intents: Vec<CompiledIntent<'c>>,
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
    let priority_fee = object.field("options").map_or(Some(0), |node| {
        let mut options = node.object(sink)?;
        let priority_fee = read_priority_fee(&mut options, sink);
        options.finish(sink);

        priority_fee
    });
    read_cluster(&mut object, sink);
    let entries = object.required("intents", sink).and_then(|node| node.array(sink));
    let pointer = object.pointer().to_owned();
    object.finish(sink);

    let entries = entries?;

    if entries.is_empty() {
        sink.push(Diagnostic::new(
            Code::InvalidValue,
            &format!("{pointer}/intents"),
            "a plan holds at least one intent",
        ));
    }

    let terms = Terms { payers: payers?, priority_fee_lamports: priority_fee? };
    let intents: Vec<Option<CompiledIntent<'c>>> =
        entries.iter().map(|node| compile_entry(node, catalog, terms, sink)).collect();

    Some(CompiledPlan { intents: intents.into_iter().collect::<Option<Vec<_>>>()? })
}

/// One intent of the plan: `interface`, `implementation`, `inputs`, and the `options` that turn a
/// check off.
fn compile_entry<'c>(
    node: &Node<'_>,
    catalog: &'c Catalog,
    terms: Terms,
    sink: &mut Sink,
) -> Option<CompiledIntent<'c>> {
    let mut object = node.object(sink)?;
    let entry = read_entry(&mut object, catalog, sink);
    let flags = object.field("options").map_or(Some(Default::default()), |node| {
        let mut options = node.object(sink)?;
        let flags = read_flags(&mut options, sink);
        options.finish(sink);

        flags
    });
    object.finish(sink);

    write_intent(entry?, terms, flags?, sink)
}

#[cfg(test)]
mod tests {
    use sdp_intents_spec::Intent;

    use super::*;
    use crate::test_support::{edit, full_catalog};

    const PLAN: &str = include_str!("../../fixtures/plans/mainnet/usdc-and-sol-transfers.json");

    #[test]
    fn each_intent_takes_the_plan_payers_and_priority_fee() {
        let catalog = full_catalog();
        let plan = compile_plan(PLAN, &catalog).unwrap();
        let intents: Vec<_> = plan.intents.iter().map(|intent| Intent::parse(&intent.bytes).unwrap()).collect();

        assert_eq!(plan.intents.len(), 2);
        assert!(intents.iter().all(|intent| intent.fee_payer() == intents[0].fee_payer()));
        assert!(intents.iter().all(|intent| intent.priority_fee_lamports() == 5_000));
        assert_eq!(plan.intents[1].implementation.id.name, "system-transfer");
    }

    #[test]
    fn an_intent_turns_off_its_own_checks() {
        let text = edit(
            PLAN,
            r#""amount": "250000000"
      },
      "options": { "assertions": false, "verifyIntent": false }"#,
            r#""amount": "250000000"
      },
      "options": { "assertions": false }"#,
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
