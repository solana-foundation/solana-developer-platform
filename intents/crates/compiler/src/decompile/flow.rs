//! A flow recipe's steps and conditions, as `implementation/flow.rs` reads them.

use sdp_intents_spec::wire::{ConditionV1, DocumentRefV1, StepInputV1, StepV1};
use sdp_intents_spec::{ConditionKind, StepValue, Submitter, ValueRef, ValueSource};
use serde_json::{Map, Value};

use super::implementation::{caret, Document};
use super::json::{object, sparse_object, utf8};
use super::{document_name, DecompileError};

impl Document<'_, '_> {
    pub(super) fn flow_recipe(&self) -> Result<Value, DecompileError> {
        let steps = self.view.steps()?;
        let names: Vec<&str> = steps.iter().map(|step| self.text(step)).collect::<Result<_, _>>()?;
        let steps: Vec<Value> = steps.iter().map(|step| self.step(step, &names)).collect::<Result<_, _>>()?;

        Ok(object([("kind", Value::from("flow")), ("steps", Value::Array(steps))]))
    }

    fn step(&self, step: &StepV1, names: &[&str]) -> Result<Value, DecompileError> {
        let intent = self.step_intent(&step.interface, &step.implementation, self.view.step_inputs(step)?)?;
        let recover = (!step.recover.is_empty())
            .then(|| self.step_intent(&step.recover, &DocumentRefV1::default(), self.view.recover_inputs(step)?))
            .transpose()?;
        let submitter = match Submitter::try_from(step.submitter)? {
            Submitter::Signer => None,
            Submitter::Owner => Some(Value::from("owner")),
            Submitter::Anyone => Some(Value::from("anyone")),
        };

        Ok(sparse_object([
            ("name", Some(Value::from(self.text(step)?))),
            ("intent", Some(intent)),
            ("ready", self.condition(step.ready, names)?),
            ("done", self.condition(step.done, names)?),
            ("recover", recover),
            ("submitter", submitter),
        ]))
    }

    fn step_intent(
        &self,
        interface: &DocumentRefV1,
        implementation: &DocumentRefV1,
        inputs: &[StepInputV1],
    ) -> Result<Value, DecompileError> {
        let values: Map<String, Value> = inputs
            .iter()
            .filter(|input| input.value.source != u8::from(ValueSource::None))
            .map(|input| {
                let name = utf8(self.view.text(input.name)?)?.to_owned();

                Ok((name, Value::from(self.names.reference(ValueRef::try_from(input.value)?)?)))
            })
            .collect::<Result<_, DecompileError>>()?;
        let pinned = (!implementation.is_empty()).then(|| self.range(implementation)).transpose()?;

        Ok(sparse_object([
            ("interface", Some(Value::from(self.range(interface)?))),
            ("implementation", pinned.map(Value::from)),
            ("inputs", Some(Value::Object(values))),
        ]))
    }

    /// `solana.org/private.shield@^1`.
    fn range(&self, document: &DocumentRefV1) -> Result<String, DecompileError> {
        let id = document_name(&document.id, self.view.text(document.name)?, self.organizations)?;

        Ok(format!("{id}@^{}", caret(document.id.version)))
    }

    fn condition(&self, index: u8, steps: &[&str]) -> Result<Option<Value>, DecompileError> {
        let Some(condition) = self.view.condition(index)? else {
            return Ok(None);
        };
        let message = self.view.text(condition.message)?;
        let message = (!message.is_empty()).then(|| self.names.template(message)).transpose()?;
        let (key, body) = self.condition_body(condition, steps)?;

        Ok(Some(sparse_object([(key, Some(body)), ("message", message.map(Value::from))])))
    }

    fn condition_body(&self, condition: &ConditionV1, steps: &[&str]) -> Result<(&'static str, Value), DecompileError> {
        let [first, second, third] = condition.args.map(ValueRef::try_from);
        let reference = |value: Result<ValueRef, _>| -> Result<Value, DecompileError> {
            Ok(Value::from(self.names.reference(value?)?))
        };

        Ok(match ConditionKind::try_from(condition.kind)? {
            ConditionKind::Exists | ConditionKind::Absent => (
                "exists",
                object([
                    ("account", reference(first)?),
                    ("exists", Value::Bool(condition.kind == u8::from(ConditionKind::Exists))),
                ]),
            ),
            kind @ (ConditionKind::Balance | ConditionKind::PrivateBalance) => (
                if kind == ConditionKind::Balance { "balance" } else { "privateBalance" },
                object([("owner", reference(first)?), ("mint", reference(second)?), ("min", reference(third)?)]),
            ),
            ConditionKind::Spent => {
                let step = StepValue::of(first?).and_then(|fact| steps.get(usize::from(fact.step)));
                let step = step.ok_or(DecompileError::Unrepresentable("a spent condition of no step"))?;

                ("spent", Value::from(format!("{{steps.{step}.plan.nullifiers}}")))
            }
        })
    }

    fn text(&self, step: &StepV1) -> Result<&str, DecompileError> {
        utf8(self.view.text(step.name)?)
    }
}
