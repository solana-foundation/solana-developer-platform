//! Post conditions, which interfaces and implementations write the same way.

use sdp_intents_spec::wire::{PostConditionV1, ValueRefV1};
use sdp_intents_spec::{CheckKind, SpecError, ValueRef};
use serde_json::{Map, Value};

use super::json::{base58, object};
use super::names::Names;
use super::DecompileError;

/// Where a check stores an argument: one of `args`, or the delegate that `delegates` keeps in
/// `programs`.
#[derive(Clone, Copy)]
enum Slot {
    Arg(usize),
    Delegate,
}

struct CheckForm {
    kind: CheckKind,
    key: &'static str,
    args: &'static [(&'static str, Slot)],
}

/// The keys of each check, in the order that the definitions write them. `crate::post_condition`
/// reads the same keys.
const FORMS: [CheckForm; 7] = [
    CheckForm {
        kind: CheckKind::Outflow,
        key: "outflow",
        args: &[("from", Slot::Arg(0)), ("mint", Slot::Arg(1)), ("max", Slot::Arg(2))],
    },
    CheckForm {
        kind: CheckKind::Inflow,
        key: "inflow",
        args: &[("to", Slot::Arg(0)), ("mint", Slot::Arg(1)), ("min", Slot::Arg(2))],
    },
    CheckForm { kind: CheckKind::NoOtherOutflows, key: "noOtherOutflows", args: &[("from", Slot::Arg(0))] },
    CheckForm { kind: CheckKind::NoAuthorityChange, key: "noAuthorityChange", args: &[("account", Slot::Arg(0))] },
    CheckForm { kind: CheckKind::InvokesOnly, key: "invokesOnly", args: &[] },
    CheckForm {
        kind: CheckKind::Delegates,
        key: "delegates",
        args: &[("from", Slot::Arg(0)), ("mint", Slot::Arg(1)), ("to", Slot::Delegate), ("max", Slot::Arg(2))],
    },
    CheckForm {
        kind: CheckKind::NoDelegate,
        key: "noDelegate",
        args: &[("from", Slot::Arg(0)), ("mint", Slot::Arg(1))],
    },
];

/// `message` is the compiled template that `condition.message` names.
pub(super) fn post_condition(
    condition: &PostConditionV1,
    message: &[u8],
    names: &Names<'_>,
) -> Result<Value, DecompileError> {
    let kind = CheckKind::try_from(condition.check)?;
    let form = FORMS.iter().find(|form| form.kind == kind).ok_or(SpecError::BadCode)?;

    let body = match kind {
        CheckKind::InvokesOnly => programs(condition, names)?,
        _ => arguments(condition, form, names)?,
    };

    Ok(object([(form.key, body), ("message", Value::from(names.template(message)?))]))
}

fn arguments(condition: &PostConditionV1, form: &CheckForm, names: &Names<'_>) -> Result<Value, DecompileError> {
    let argument = |slot: Slot| -> Result<ValueRefV1, DecompileError> {
        match slot {
            Slot::Arg(index) => condition.args.get(index).copied().ok_or(DecompileError::Spec(SpecError::BadIndex)),
            Slot::Delegate => Ok(condition.delegate()),
        }
    };

    let entries: Map<String, Value> = form
        .args
        .iter()
        .map(|(key, slot)| {
            let value = names.reference(ValueRef::try_from(argument(*slot)?)?)?;

            Ok(((*key).to_owned(), Value::from(value)))
        })
        .collect::<Result<_, DecompileError>>()?;

    Ok(Value::Object(entries))
}

fn programs(condition: &PostConditionV1, names: &Names<'_>) -> Result<Value, DecompileError> {
    let first = usize::from(condition.programs.first);
    let end = first.saturating_add(usize::from(condition.programs.count));
    let programs = names.addresses.get(first..end).ok_or(SpecError::OutOfBounds)?;

    Ok(Value::Array(programs.iter().map(|program| Value::from(base58(program))).collect()))
}
