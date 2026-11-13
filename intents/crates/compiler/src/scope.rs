//! Resolves a reference such as `{inputs.amount}` to the `ValueRefV1` that the binary form holds,
//! with the type of the value it names.

use sdp_intents_spec::wire::ValueRefV1;
use sdp_intents_spec::{BaseType, ValueSource, ValueType};

use crate::diagnostic::{Code, Diagnostic};
use crate::encoding::Shape;
use crate::reader::{list, Sink};
use crate::reference::{Reference, Scope};
use crate::suggest::closest;

const PAYERS: [&str; 2] = ["fee", "rent"];
/// `{builder.bumps}`: the canonical bumps of the builder's program addresses, in borsh.
const BUILDER: [&str; 1] = ["bumps"];
const BYTES: Shape = Shape { value_type: ValueType { base: BaseType::Bytes, array: false }, optional: false };
const ADDRESS: Shape = Shape { value_type: ValueType { base: BaseType::Address, array: false }, optional: false };

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    pub name: String,
    pub shape: Shape,
}

/// The inputs and outputs of an interface, in order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Schema {
    pub inputs: Vec<Field>,
    pub outputs: Vec<Field>,
}

/// Which scopes a reference at one place may name. Only a program recipe's builder call can name
/// `builder`.
#[derive(Clone, Copy, Debug)]
pub struct Allowed {
    pub payers: bool,
    pub accounts: bool,
    pub builder: bool,
}

/// The names that a reference at one place can see. `accounts` holds only the accounts that the
/// place can name, such as the accounts before the one being read. `failed` holds names whose own
/// definition already has a finding. A reference to one of them resolves to nothing, with no
/// second finding.
#[derive(Clone, Copy)]
pub struct Names<'s> {
    pub schema: &'s Schema,
    pub accounts: &'s [String],
    pub allowed: Allowed,
    pub failed: &'s [String],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub value: ValueRefV1,
    pub shape: Shape,
}

impl<'s> Names<'s> {
    pub fn new(schema: &'s Schema, accounts: &'s [String], allowed: Allowed) -> Self {
        Self { schema, accounts, allowed, failed: &[] }
    }

    pub fn resolve(&self, reference: Reference<'_>, pointer: &str, sink: &mut Sink) -> Option<Resolved> {
        let allowed = match reference.scope {
            Scope::Inputs | Scope::Outputs => true,
            Scope::Payers => self.allowed.payers,
            Scope::Accounts => self.allowed.accounts,
            Scope::Builder => self.allowed.builder,
        };

        if self.failed.iter().any(|name| name == reference.name) {
            return None;
        }

        if !allowed {
            sink.push(Diagnostic::new(
                Code::ReferenceNotAllowed,
                pointer,
                format!("`{}` cannot be named here", reference.scope.as_str()),
            ));

            return None;
        }

        if reference.scope == Scope::Payers && reference.name == "fee" {
            sink.push(Diagnostic::new(Code::ReferenceNotAllowed, pointer, "a recipe cannot name the fee payer").help(
                "the runtime charges the fee payer, so no instruction names it. Use `{payers.rent}` to fund an account",
            ));

            return None;
        }

        let found = match reference.scope {
            Scope::Inputs => find(&self.schema.inputs, reference.name, ValueSource::Input),
            Scope::Outputs => find(&self.schema.outputs, reference.name, ValueSource::Output),
            Scope::Payers => position(PAYERS.iter().copied(), reference.name, ValueSource::Payer, ADDRESS),
            Scope::Accounts => {
                position(self.accounts.iter().map(String::as_str), reference.name, ValueSource::Account, ADDRESS)
            }
            Scope::Builder => position(BUILDER.iter().copied(), reference.name, ValueSource::Bumps, BYTES),
        };

        if found.is_none() {
            sink.push(self.unknown(reference, pointer));
        }

        found
    }

    fn unknown(&self, reference: Reference<'_>, pointer: &str) -> Diagnostic {
        let names: Vec<&str> = match reference.scope {
            Scope::Inputs => self.schema.inputs.iter().map(|field| field.name.as_str()).collect(),
            Scope::Outputs => self.schema.outputs.iter().map(|field| field.name.as_str()).collect(),
            Scope::Payers => PAYERS.to_vec(),
            Scope::Accounts => self.accounts.iter().map(String::as_str).collect(),
            Scope::Builder => BUILDER.to_vec(),
        };
        let scope = reference.scope.as_str();
        let diagnostic = Diagnostic::new(
            Code::UnknownReference,
            pointer,
            format!("`{{{scope}.{}}}` names nothing in `{scope}`", reference.name),
        );

        if let Some(known) = closest(reference.name, names.iter().copied()) {
            return diagnostic.help(format!("did you mean `{{{scope}.{known}}}`?"));
        }

        match (names.is_empty(), reference.scope) {
            (true, Scope::Accounts) => diagnostic.help("an account can name only the accounts before it"),
            (true, _) => diagnostic.help(format!("`{scope}` is empty here")),
            (false, _) => diagnostic.help(format!("`{scope}` holds {}", list(&names))),
        }
    }
}

fn find(fields: &[Field], name: &str, source: ValueSource) -> Option<Resolved> {
    let index = fields.iter().position(|field| field.name == name)?;
    let shape = fields.get(index)?.shape;

    Some(Resolved { value: ValueRefV1 { source: source.into(), index: u8::try_from(index).ok()? }, shape })
}

fn position<'n>(
    mut names: impl Iterator<Item = &'n str>,
    name: &str,
    source: ValueSource,
    shape: Shape,
) -> Option<Resolved> {
    let index = names.position(|known| known == name)?;

    Some(Resolved { value: ValueRefV1 { source: source.into(), index: u8::try_from(index).ok()? }, shape })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Schema {
        let field = |name: &str, base| Field {
            name: name.to_owned(),
            shape: Shape { value_type: ValueType { base, array: false }, optional: false },
        };

        Schema { inputs: vec![field("from", BaseType::Address), field("amount", BaseType::U64)], outputs: Vec::new() }
    }

    #[test]
    fn resolves_inputs_and_payers() {
        let schema = schema();
        let names = Names::new(&schema, &[], Allowed { payers: true, accounts: false, builder: false });
        let mut sink = Sink::default();

        let amount = names.resolve(Reference { scope: Scope::Inputs, name: "amount" }, "/x", &mut sink).unwrap();
        let rent = names.resolve(Reference { scope: Scope::Payers, name: "rent" }, "/x", &mut sink).unwrap();

        assert_eq!(amount.value, ValueRefV1 { source: 1, index: 1 });
        assert_eq!(rent.value, ValueRefV1 { source: 3, index: 1 });
        assert!(sink.is_empty());
    }

    #[test]
    fn a_recipe_cannot_name_the_fee_payer() {
        let schema = schema();
        let names = Names::new(&schema, &[], Allowed { payers: true, accounts: false, builder: false });
        let mut sink = Sink::default();

        assert!(names.resolve(Reference { scope: Scope::Payers, name: "fee" }, "/x", &mut sink).is_none());
        assert_eq!(sink.into_diagnostics().first().unwrap().code, Code::ReferenceNotAllowed);
    }

    #[test]
    fn suggests_the_name_that_was_meant() {
        let schema = schema();
        let names = Names::new(&schema, &[], Allowed { payers: false, accounts: false, builder: false });
        let mut sink = Sink::default();

        assert!(names.resolve(Reference { scope: Scope::Inputs, name: "amout" }, "/x", &mut sink).is_none());
        assert!(names.resolve(Reference { scope: Scope::Payers, name: "fee" }, "/y", &mut sink).is_none());

        let diagnostics = sink.into_diagnostics();
        assert_eq!(diagnostics.first().unwrap().help.as_deref(), Some("did you mean `{inputs.amount}`?"));
        assert_eq!(diagnostics.get(1).unwrap().code, Code::ReferenceNotAllowed);
    }
}
