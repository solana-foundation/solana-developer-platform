use sdp_intents_spec::wire::{InputV1, OutputV1};
use sdp_intents_spec::{Interface, ValueSource};
use serde_json::Value;

use super::json::{flag, object, sparse_object, value_type};
use super::names::Names;
use super::post_condition::post_condition;
use super::{document_name, DecompileError, Organizations};
use crate::envelope::SPEC;
use crate::id::format_version;

pub fn decompile_interface(bytes: &[u8], organizations: &Organizations) -> Result<Value, DecompileError> {
    let interface = Interface::parse(bytes)?;
    let names = Names::new(&interface, Vec::new(), interface.addresses()?)?;

    if !interface.literals()?.is_empty() {
        return Err(DecompileError::Unrepresentable("a literals table"));
    }

    let inputs: Vec<Value> = interface
        .inputs()?
        .iter()
        .zip(&names.inputs)
        .map(|(input, name)| input_entry(input, name, &names))
        .collect::<Result<_, _>>()?;

    let outputs: Vec<Value> = interface
        .outputs()?
        .iter()
        .zip(&names.outputs)
        .map(|(output, name)| output_entry(output, name))
        .collect::<Result<_, _>>()?;

    let post_conditions: Vec<Value> = interface
        .post_conditions()?
        .iter()
        .map(|condition| post_condition(condition, interface.text(condition.message)?, &names))
        .collect::<Result<_, _>>()?;

    Ok(sparse_object([
        ("spec", Some(Value::from(SPEC))),
        ("kind", Some(Value::from("interface"))),
        ("id", Some(Value::from(document_name(interface.id(), interface.name()?, organizations)?))),
        ("version", Some(Value::from(format_version(interface.id().version)))),
        ("settlement", interface.settles_later().then(|| Value::from("async"))),
        ("inputs", Some(Value::Array(inputs))),
        ("outputs", Some(Value::Array(outputs))),
        ("display", Some(Value::from(names.template(interface.display()?)?))),
        ("postConditions", Some(Value::Array(post_conditions))),
    ]))
}

fn input_entry(input: &InputV1, name: &str, names: &Names<'_>) -> Result<Value, DecompileError> {
    let mint = input.amount_mint()?;
    let display = match mint.source {
        ValueSource::None => None,
        _ => Some(object([("amount", object([("mint", Value::from(names.reference(mint)?))]))])),
    };

    Ok(sparse_object([
        ("name", Some(Value::from(name))),
        ("type", Some(value_type(input.value_type()?))),
        ("signer", flag(input.signer())),
        ("optional", flag(input.optional())),
        ("display", display),
    ]))
}

fn output_entry(output: &OutputV1, name: &str) -> Result<Value, DecompileError> {
    Ok(object([("name", Value::from(name)), ("type", value_type(output.value_type()?))]))
}
