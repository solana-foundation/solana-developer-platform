//! Finds the document that an id and a range name, such as `solana.org/token.transfer@^1`, in the
//! catalog.

use sdp_intents_spec::wire::SemverV1;

use crate::catalog::Catalog;
use crate::diagnostic::{Code, Diagnostic};
use crate::envelope::reported;
use crate::id::{format_version, IdRange};
use crate::implementation::CompiledImplementation;
use crate::interface::CompiledInterface;
use crate::reader::{list, Node, Sink};

/// The interface that a range names, and the lowest version that the range accepts.
pub struct InterfaceMatch<'c> {
    pub interface: &'c CompiledInterface,
    pub lowest: SemverV1,
}

/// An implementation names a caret range, because its binary form holds only the lowest version.
pub fn read_implements<'c>(node: &Node<'_>, catalog: &'c Catalog, sink: &mut Sink) -> Option<InterfaceMatch<'c>> {
    let range = reported(IdRange::parse(node.str(sink)?), node, sink)?;

    if range.exact {
        sink.push(
            Diagnostic::new(Code::InvalidValue, &node.pointer, "an implementation names a range of its interface")
                .help(format!("use `{}@^{}`", range.id, range.lowest.major.get())),
        );

        return None;
    }

    read_interface_range(&range, node, catalog, sink)
}

pub fn read_interface<'c>(node: &Node<'_>, catalog: &'c Catalog, sink: &mut Sink) -> Option<InterfaceMatch<'c>> {
    let range = reported(IdRange::parse(node.str(sink)?), node, sink)?;

    read_interface_range(&range, node, catalog, sink)
}

fn read_interface_range<'c>(
    range: &IdRange,
    node: &Node<'_>,
    catalog: &'c Catalog,
    sink: &mut Sink,
) -> Option<InterfaceMatch<'c>> {
    let id = range.id.to_string();

    let Some(interface) = catalog.interface(&id) else {
        sink.push(missing_interface(&id, &node.pointer, catalog));

        return None;
    };

    check_covered(range, interface.version, &node.pointer, sink)?;

    Some(InterfaceMatch { interface, lowest: range.lowest })
}

pub fn read_implementation<'c>(
    node: &Node<'_>,
    catalog: &'c Catalog,
    sink: &mut Sink,
) -> Option<&'c CompiledImplementation> {
    let range = reported(IdRange::parse(node.str(sink)?), node, sink)?;
    let id = range.id.to_string();

    let Some(implementation) = catalog.implementation(&id) else {
        sink.push(
            Diagnostic::new(Code::UnknownImplementation, &node.pointer, format!("no implementation `{id}` is defined"))
                .help(format!("the defined implementations are {}", list(&catalog.implementation_ids()))),
        );

        return None;
    };

    check_covered(&range, implementation.version, &node.pointer, sink)?;

    Some(implementation)
}

fn check_covered(range: &IdRange, defined: SemverV1, pointer: &str, sink: &mut Sink) -> Option<()> {
    if range.covers(defined) {
        return Some(());
    }

    let id = &range.id;
    sink.push(
        Diagnostic::new(
            Code::VersionMismatch,
            pointer,
            format!("`{id}` is at version {}, which this range does not cover", format_version(defined)),
        )
        .help(format!("use `{id}@^{}`", defined.major.get())),
    );

    None
}

fn missing_interface(id: &str, pointer: &str, catalog: &Catalog) -> Diagnostic {
    if catalog.interface_failed(id) {
        return Diagnostic::new(Code::InterfaceFailed, pointer, format!("interface `{id}` did not compile"))
            .help(format!("fix the findings in `{id}` first"));
    }

    Diagnostic::new(Code::UnknownInterface, pointer, format!("no interface `{id}` is defined"))
        .help(format!("the defined interfaces are {}", list(&catalog.interface_ids())))
}
