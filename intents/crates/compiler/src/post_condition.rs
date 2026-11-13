//! Post conditions, which interfaces and implementations write the same way:
//! `{ "outflow": { "from": "{inputs.from}", "mint": "{inputs.mint}", "max": "{inputs.amount}" }, "message": "…" }`.

use sdp_intents_spec::wire::{PostConditionV1, RangeV1, ValueRefV1};
use sdp_intents_spec::{Address, BaseType, CheckKind};

use crate::diagnostic::{Code, Diagnostic};
use crate::encoding::address;
use crate::reader::{list, Node, Object, Sink};
use crate::reference::{parse_value, ValueText};
use crate::scope::Names;
use crate::template::compile_template;
use crate::writer::{AddressTable, Pool};

/// The kind of value that an argument must name.
#[derive(Clone, Copy)]
enum Want {
    Address,
    Mint,
    Amount,
}

struct Check {
    key: &'static str,
    kind: CheckKind,
    args: &'static [(&'static str, Want)],
}

const CHECKS: [Check; 7] = [
    Check {
        key: "outflow",
        kind: CheckKind::Outflow,
        args: &[("from", Want::Address), ("mint", Want::Mint), ("max", Want::Amount)],
    },
    Check {
        key: "inflow",
        kind: CheckKind::Inflow,
        args: &[("to", Want::Address), ("mint", Want::Mint), ("min", Want::Amount)],
    },
    Check { key: "noOtherOutflows", kind: CheckKind::NoOtherOutflows, args: &[("from", Want::Address)] },
    Check { key: "noAuthorityChange", kind: CheckKind::NoAuthorityChange, args: &[("account", Want::Address)] },
    Check { key: "invokesOnly", kind: CheckKind::InvokesOnly, args: &[] },
    Check {
        key: "delegates",
        kind: CheckKind::Delegates,
        args: &[("from", Want::Address), ("mint", Want::Mint), ("max", Want::Amount), ("to", Want::Address)],
    },
    Check { key: "noDelegate", kind: CheckKind::NoDelegate, args: &[("from", Want::Address), ("mint", Want::Mint)] },
];

/// Where post conditions write their text and their program addresses.
pub struct Output<'w> {
    pub pool: &'w mut Pool,
    pub addresses: &'w mut AddressTable,
}

/// `allow_invokes_only` is false for an interface, because an interface names no programs.
pub fn read_post_condition(
    node: &Node<'_>,
    names: &Names<'_>,
    allow_invokes_only: bool,
    output: Output<'_>,
    sink: &mut Sink,
) -> Option<PostConditionV1> {
    let mut object = node.object(sink)?;
    let message = object.required("message", sink).and_then(|message| compile_template(&message, names, sink));
    let check = find_check(&object, sink)?;
    let body = object.required(check.key, sink)?;
    object.finish(sink);

    if check.kind == CheckKind::InvokesOnly && !allow_invokes_only {
        sink.push(
            Diagnostic::new(Code::InvalidValue, &body.pointer, "an interface cannot state `invokesOnly`")
                .at_key()
                .help("an interface names no programs. State `invokesOnly` in the implementation record."),
        );

        return None;
    }

    let mut condition =
        PostConditionV1 { check: check.kind.into(), message: output.pool.add(&message?), ..PostConditionV1::default() };

    if check.kind == CheckKind::InvokesOnly {
        condition.programs = read_programs(&body, output.addresses, sink)?;
    } else {
        let args = read_args(&body, check, names, sink)?;
        let (first_three, fourth) = args.split_at(args.len().min(3));
        condition.args.iter_mut().zip(first_three).for_each(|(slot, value)| *slot = *value);

        // `delegates` holds its delegate in `programs` (`PostConditionV1::delegate`).
        if let Some(delegate) = fourth.first() {
            condition.programs = RangeV1 { first: delegate.source, count: delegate.index };
        }
    }

    Some(condition)
}

fn find_check(object: &Object<'_>, sink: &mut Sink) -> Option<&'static Check> {
    let keys: Vec<&str> = CHECKS.iter().map(|check| check.key).collect();
    let found = object.only_key_except("message").and_then(|key| CHECKS.iter().find(|check| check.key == key));

    if found.is_none() {
        sink.push(
            Diagnostic::new(Code::MissingKey, object.pointer(), "a post condition names one check")
                .help(format!("the checks are {}", list(&keys))),
        );
    }

    found
}

fn read_args(body: &Node<'_>, check: &Check, names: &Names<'_>, sink: &mut Sink) -> Option<Vec<ValueRefV1>> {
    let mut object = body.object(sink)?;
    let resolved: Vec<Option<ValueRefV1>> = check
        .args
        .iter()
        .map(|(key, want)| object.required(key, sink).and_then(|arg| read_arg(&arg, *want, names, sink)))
        .collect();
    object.finish(sink);

    resolved.into_iter().collect()
}

fn read_arg(node: &Node<'_>, want: Want, names: &Names<'_>, sink: &mut Sink) -> Option<ValueRefV1> {
    let text = node.str(sink)?;

    let reference = match parse_value(text) {
        Ok(ValueText::Reference(reference)) => reference,
        Ok(ValueText::Literal(_)) => {
            sink.push(
                Diagnostic::new(Code::InvalidValue, &node.pointer, "a post condition argument must be a reference")
                    .help("name an input or an output, such as `{inputs.amount}`"),
            );

            return None;
        }
        Err(reason) => {
            sink.push(Diagnostic::new(Code::BadTemplate, &node.pointer, reason));

            return None;
        }
    };

    let resolved = names.resolve(reference, &node.pointer, sink)?;
    let base = resolved.shape.value_type.base;

    let fits = !resolved.shape.value_type.array
        && match want {
            Want::Address => matches!(base, BaseType::Address | BaseType::Mint),
            Want::Mint => base == BaseType::Mint,
            Want::Amount => {
                matches!(base, BaseType::U8 | BaseType::U16 | BaseType::U32 | BaseType::U64 | BaseType::U128)
            }
        };

    if !fits {
        let expected = match want {
            Want::Address => "an address",
            Want::Mint => "a mint",
            Want::Amount => "an unsigned amount",
        };

        sink.push(Diagnostic::new(
            Code::InvalidValue,
            &node.pointer,
            format!("`{text}` is a `{}`, and this argument needs {expected}", crate::value_type::name(base)),
        ));

        return None;
    }

    Some(resolved.value)
}

fn read_programs(body: &Node<'_>, addresses: &mut AddressTable, sink: &mut Sink) -> Option<RangeV1> {
    let programs = body.array(sink)?;
    let parsed: Vec<Option<Address>> = programs
        .iter()
        .map(|program| {
            let text = program.str(sink)?;

            address(text)
                .map(Address::from)
                .map_err(|reason| sink.push(Diagnostic::new(Code::InvalidValue, &program.pointer, reason)))
                .ok()
        })
        .collect();
    let programs: Vec<Address> = parsed.into_iter().collect::<Option<_>>()?;

    Some(addresses.push_run(&programs))
}
