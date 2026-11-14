//! A flow recipe (`DESIGN.md`, 4.19): steps that each name an interface, with conditions on chain
//! state. A step input or a condition argument is a reference to the flow's own inputs or payers,
//! or a fact of a step's plan, such as `{steps.pay.plan.nullifiers}`.

use sdp_intents_spec::wire::{
    ConditionV1, DocumentRefV1, StepInputV1, StepV1, ValueRefV1, NO_CONDITION, STEP_FACT_NULLIFIERS,
};
use sdp_intents_spec::{BaseType, ConditionKind, RecipeKind, StepValue, Submitter, ValueSource};

use super::recipe::Recipe;
use super::Build;
use crate::diagnostic::{Code, Diagnostic};
use crate::envelope::reported;
use crate::id::IdRange;
use crate::reader::{list, Node, Object};
use crate::reference::{parse_value, ValueText};
use crate::resolve::{read_implementation, read_interface};
use crate::scope::{Allowed, Field, Names};
use crate::template::compile_template;

const CONDITIONS: [&str; 4] = ["exists", "balance", "privateBalance", "spent"];
const SUBMITTERS: [&str; 2] = ["owner", "anyone"];
/// The start of a reference to a step, and the end of a reference to its nullifiers.
const STEP_REFERENCE: &str = "\x7bsteps.";
const NULLIFIERS_END: &str = ".plan.nullifiers\x7d";

/// What a condition argument must name.
#[derive(Clone, Copy)]
enum Want {
    Address,
    Mint,
    Amount,
}

impl Build<'_, '_> {
    /// `{ "steps": [ … ] }`. Every step's name is known before any step reads, so a condition can
    /// name its own step's plan.
    pub(super) fn read_flow(&mut self, object: &mut Object<'_>) -> Option<Recipe> {
        let steps = object.required("steps", self.sink).and_then(|steps| steps.array(self.sink))?;
        let names: Vec<String> = steps
            .iter()
            .map(|step| step.value.get("name").and_then(|name| name.as_str()).unwrap_or_default().to_owned())
            .collect();

        if steps.is_empty() {
            self.sink.push(Diagnostic::new(Code::MissingKey, object.pointer(), "a flow has at least one step"));
        }

        steps.iter().zip(0u8..).for_each(|(step, position)| self.read_step(step, position, &names));

        Some(Recipe { kind: RecipeKind::Flow, url: Vec::new() })
    }

    fn read_step(&mut self, node: &Node<'_>, position: u8, steps: &[String]) {
        let Some(mut object) = node.object(self.sink) else {
            return;
        };
        let name = object.required("name", self.sink).and_then(|name| name.str(self.sink).map(str::to_owned));
        let intent = object.required("intent", self.sink).and_then(|intent| self.read_step_intent(&intent, position));
        let ready = object.field("ready").map(|ready| self.read_condition(&ready, steps));
        let done = object.field("done").map(|done| self.read_condition(&done, steps));
        let recover = object.field("recover").and_then(|recover| self.read_step_intent(&recover, position));
        let submitter = object.field("submitter").map(|submitter| self.read_submitter(&submitter));
        object.finish(self.sink);

        let (Some(name), Some(intent)) = (name, intent) else {
            return;
        };
        let recover = recover.unwrap_or_default();
        let condition = |index: Option<Option<u8>>| index.flatten().unwrap_or(NO_CONDITION);

        self.steps.push(StepV1 {
            name: self.pool.add(name.as_bytes()),
            interface: intent.interface,
            implementation: intent.implementation,
            inputs: intent.inputs,
            ready: condition(ready),
            done: condition(done),
            recover: recover.interface,
            recover_inputs: recover.inputs,
            submitter: submitter.flatten().unwrap_or(Submitter::Signer).into(),
        });
    }

    /// `{ "interface": "…@^1", "implementation": "…@^1", "inputs": { … } }`. The implementation is
    /// optional, and so is an optional input of the interface.
    fn read_step_intent(&mut self, node: &Node<'_>, position: u8) -> Option<StepIntent> {
        let mut object = node.object(self.sink)?;
        let interface = object.required("interface", self.sink).and_then(|node| {
            let found = read_interface(&node, self.catalog, self.sink)?;

            Some((found.interface, found.lowest))
        });
        let implementation = object.field("implementation");
        let inputs = object.required("inputs", self.sink);
        object.finish(self.sink);

        let (interface, lowest) = interface?;
        let implementation = match implementation {
            Some(node) => self.read_pinned_implementation(&node, interface)?,
            None => DocumentRefV1::default(),
        };
        let inputs = self.read_step_inputs(&inputs?, &interface.schema.inputs, position)?;

        Some(StepIntent {
            interface: DocumentRefV1 {
                id: sdp_intents_spec::wire::DocumentIdV1 { version: lowest, ..interface.document_id },
                name: self.pool.add(interface.id.name.as_bytes()),
            },
            implementation,
            inputs,
        })
    }

    fn read_pinned_implementation(
        &mut self,
        node: &Node<'_>,
        interface: &crate::interface::CompiledInterface,
    ) -> Option<DocumentRefV1> {
        let lowest = reported(IdRange::parse(node.str(self.sink)?), node, self.sink)?.lowest;
        let implementation = read_implementation(node, self.catalog, self.sink)?;
        let implements = implementation.implements;

        if implements.publisher != interface.document_id.publisher
            || implements.name_hash != interface.document_id.name_hash
        {
            self.sink.push(Diagnostic::new(
                Code::InvalidValue,
                &node.pointer,
                format!("`{}` does not implement `{}`", implementation.id, interface.id),
            ));

            return None;
        }

        Some(DocumentRefV1 {
            id: sdp_intents_spec::wire::DocumentIdV1 { version: lowest, ..implementation.document_id },
            name: self.pool.add(implementation.id.name.as_bytes()),
        })
    }

    /// One value for each input of the step's interface, in its order.
    fn read_step_inputs(
        &mut self,
        node: &Node<'_>,
        fields: &[Field],
        position: u8,
    ) -> Option<sdp_intents_spec::wire::RangeV1> {
        let mut object = node.object(self.sink)?;
        let values: Vec<Option<StepInputV1>> = fields
            .iter()
            .map(|field| {
                let value = match object.field(&field.name) {
                    Some(value) => self.read_step_value(&value, field, position)?,
                    None if field.shape.optional => ValueRefV1::default(),
                    None => {
                        self.sink.push(Diagnostic::new(
                            Code::MissingKey,
                            object.pointer(),
                            format!("the step gives no value for the input `{}`", field.name),
                        ));

                        return None;
                    }
                };

                Some(StepInputV1 { name: self.pool.add(field.name.as_bytes()), value })
            })
            .collect();
        object.finish(self.sink);

        let values: Vec<StepInputV1> = values.into_iter().collect::<Option<_>>()?;
        let first = self.step_inputs.len();
        self.step_inputs.extend(values);

        super::recipe::range(first, self.step_inputs.len())
    }

    /// A step input names one of the flow's inputs or payers, of the same type as the step's input.
    fn read_step_value(&mut self, node: &Node<'_>, field: &Field, position: u8) -> Option<ValueRefV1> {
        let text = node.str(self.sink)?;

        if text.starts_with(STEP_REFERENCE) {
            self.sink.push(
                Diagnostic::new(Code::ReferenceNotAllowed, &node.pointer, "a step input cannot name another step yet")
                    .help(format!("step {position} can name the flow's inputs and payers")),
            );

            return None;
        }

        let resolved = self.resolve_flow_reference(node, text)?;
        let (given, wanted) = (resolved.shape.value_type, field.shape.value_type);
        let compatible = given.array == wanted.array
            && (given.base == wanted.base || is_address(given.base) && is_address(wanted.base));

        if !compatible {
            self.sink.push(Diagnostic::new(
                Code::InvalidValue,
                &node.pointer,
                format!(
                    "`{text}` is a `{}`, and the input `{}` is a `{}`",
                    crate::value_type::name(given.base),
                    field.name,
                    crate::value_type::name(wanted.base)
                ),
            ));

            return None;
        }

        Some(resolved.value)
    }

    /// `{ "<kind>": …, "message": "…" }`, with one kind of `CONDITIONS`.
    fn read_condition(&mut self, node: &Node<'_>, steps: &[String]) -> Option<u8> {
        let mut object = node.object(self.sink)?;
        let message = object.field("message").and_then(|message| {
            let names = Names::new(self.schema, &[], Allowed { payers: true, accounts: false, builder: false });

            compile_template(&message, &names, self.sink)
        });
        let kind = object.only_key_except("message").filter(|key| CONDITIONS.contains(key)).map(str::to_owned);

        let Some(kind) = kind else {
            self.sink.push(
                Diagnostic::new(Code::MissingKey, object.pointer(), "a condition names one kind")
                    .help(format!("the kinds are {}", list(&CONDITIONS))),
            );
            return None;
        };

        let body = object.required(&kind, self.sink)?;
        let condition = match kind.as_str() {
            "exists" => self.read_exists(&body),
            "balance" => self.read_balance(&body, ConditionKind::Balance),
            "privateBalance" => self.read_balance(&body, ConditionKind::PrivateBalance),
            _ => self.read_spent(&body, steps),
        };
        object.finish(self.sink);

        let condition = ConditionV1 { message: self.pool.add(&message.unwrap_or_default()), ..condition? };
        let index = u8::try_from(self.conditions.len()).ok()?;
        self.conditions.push(condition);

        Some(index)
    }

    /// `{ "account": "{inputs.vault}", "exists": true }`, where `exists` is the key's value.
    fn read_exists(&mut self, body: &Node<'_>) -> Option<ConditionV1> {
        let mut object = body.object(self.sink)?;
        let account = object.required("account", self.sink).and_then(|account| self.read_arg(&account, Want::Address));
        let exists = object.required("exists", self.sink).and_then(|exists| match exists.value.as_bool() {
            Some(exists) => Some(exists),
            None => {
                self.sink.push(Diagnostic::new(Code::WrongType, &exists.pointer, "expected `true` or `false`"));
                None
            }
        });
        object.finish(self.sink);

        let kind = if exists? { ConditionKind::Exists } else { ConditionKind::Absent };

        Some(ConditionV1 {
            kind: kind.into(),
            args: [account?, ValueRefV1::default(), ValueRefV1::default()],
            ..ConditionV1::default()
        })
    }

    /// `{ "owner": …, "mint": …, "min": … }`.
    fn read_balance(&mut self, body: &Node<'_>, kind: ConditionKind) -> Option<ConditionV1> {
        let mut object = body.object(self.sink)?;
        let args = [("owner", Want::Address), ("mint", Want::Mint), ("min", Want::Amount)]
            .map(|(key, want)| object.required(key, self.sink).and_then(|arg| self.read_arg(&arg, want)));
        object.finish(self.sink);

        let [owner, mint, min] = args;

        Some(ConditionV1 { kind: kind.into(), args: [owner?, mint?, min?], ..ConditionV1::default() })
    }

    /// `"{steps.<name>.plan.nullifiers}"`.
    fn read_spent(&mut self, body: &Node<'_>, steps: &[String]) -> Option<ConditionV1> {
        let text = body.str(self.sink)?;
        let step = text
            .strip_prefix(STEP_REFERENCE)
            .and_then(|rest| rest.strip_suffix(NULLIFIERS_END))
            .and_then(|name| steps.iter().position(|known| known == name))
            .and_then(|position| u8::try_from(position).ok());

        let Some(step) = step else {
            self.sink.push(
                Diagnostic::new(Code::UnknownReference, &body.pointer, format!("`{text}` names no step's nullifiers"))
                    .help(format!("name `{{steps.<name>.plan.nullifiers}}`, with a step of {}", list(steps))),
            );
            return None;
        };

        let index = StepValue { step, item: STEP_FACT_NULLIFIERS }.index()?;
        let fact = ValueRefV1 { source: ValueSource::StepFact.into(), index };

        Some(ConditionV1 {
            kind: ConditionKind::Spent.into(),
            args: [fact, ValueRefV1::default(), ValueRefV1::default()],
            ..ConditionV1::default()
        })
    }

    fn read_arg(&mut self, node: &Node<'_>, want: Want) -> Option<ValueRefV1> {
        let text = node.str(self.sink)?;
        let resolved = self.resolve_flow_reference(node, text)?;
        let base = resolved.shape.value_type.base;
        let fits = !resolved.shape.value_type.array
            && match want {
                Want::Address => is_address(base),
                Want::Mint => base == BaseType::Mint,
                Want::Amount => matches!(base, BaseType::U8 | BaseType::U16 | BaseType::U32 | BaseType::U64),
            };

        if !fits {
            self.sink.push(Diagnostic::new(
                Code::InvalidValue,
                &node.pointer,
                format!("`{text}` is a `{}`, which this argument cannot take", crate::value_type::name(base)),
            ));

            return None;
        }

        Some(resolved.value)
    }

    /// A reference to the flow's inputs or payers. A flow has no accounts and no builder.
    fn resolve_flow_reference(&mut self, node: &Node<'_>, text: &str) -> Option<crate::scope::Resolved> {
        let reference = match parse_value(text) {
            Ok(ValueText::Reference(reference)) => reference,
            Ok(ValueText::Literal(_)) => {
                self.sink.push(
                    Diagnostic::new(Code::InvalidValue, &node.pointer, "a flow value must be a reference")
                        .help("name one of the flow's inputs, such as `{inputs.amount}`"),
                );
                return None;
            }
            Err(reason) => {
                self.sink.push(Diagnostic::new(Code::BadTemplate, &node.pointer, reason));
                return None;
            }
        };
        let names = Names::new(self.schema, &[], Allowed { payers: true, accounts: false, builder: false });

        names.resolve(reference, &node.pointer, self.sink)
    }

    fn read_submitter(&mut self, node: &Node<'_>) -> Option<Submitter> {
        match node.str(self.sink)? {
            "owner" => Some(Submitter::Owner),
            "anyone" => Some(Submitter::Anyone),
            other => {
                self.sink.push(
                    Diagnostic::new(Code::InvalidValue, &node.pointer, format!("`{other}` is not a submitter"))
                        .help(format!("the submitters are {}", list(&SUBMITTERS))),
                );
                None
            }
        }
    }
}

/// A step's interface, its pinned implementation, and its input values.
#[derive(Default)]
struct StepIntent {
    interface: DocumentRefV1,
    implementation: DocumentRefV1,
    inputs: sdp_intents_spec::wire::RangeV1,
}

fn is_address(base: BaseType) -> bool {
    matches!(base, BaseType::Address | BaseType::Mint)
}
