use sdp_intents_spec::wire::{AppliesV1, SemverV1};
use sdp_intents_spec::{AppliesKind, Implementation, Interface, SpecError, ValueRef};
use serde_json::Value;

use super::json::{base58, hex, non_empty, object, sparse_object, utf8};
use super::names::Names;
use super::post_condition::post_condition;
use super::{document_name, DecompileError, Organizations};
use crate::envelope::SPEC;
use crate::id::{caret_covers, format_version};

/// An implementation, with the names that its references resolve to. The steps that read the
/// recipe are methods in `recipe.rs`, `accounts.rs`, and `programs.rs`.
pub(super) struct Document<'d, 'n> {
    pub(super) view: Implementation<'d>,
    pub(super) names: &'n Names<'d>,
}

pub fn decompile_implementation(
    bytes: &[u8],
    interface: &[u8],
    organizations: &Organizations,
) -> Result<Value, DecompileError> {
    let view = Implementation::parse(bytes)?;
    let interface = Interface::parse(interface)?;
    let implements = implements(&view, &interface, organizations)?;

    if !view.literals()?.is_empty() {
        return Err(DecompileError::Unrepresentable("a literals table"));
    }

    let accounts: Vec<String> = view
        .accounts()?
        .iter()
        .map(|account| view.text(account.name).map_err(DecompileError::from).and_then(utf8).map(str::to_owned))
        .collect::<Result<_, _>>()?;

    let names = Names::new(&interface, accounts, view.addresses()?)?;
    let document = Document { view, names: &names };

    let applies: Vec<Value> =
        view.applies()?.iter().map(|applies| applies_hint(applies, &names)).collect::<Result<_, _>>()?;

    let post_conditions: Vec<Value> = view
        .post_conditions()?
        .iter()
        .map(|condition| post_condition(condition, view.text(condition.message)?, &names))
        .collect::<Result<_, _>>()?;

    Ok(sparse_object([
        ("spec", Some(Value::from(SPEC))),
        ("kind", Some(Value::from("implementation"))),
        ("id", Some(Value::from(document_name(view.id(), view.name()?, organizations)?))),
        ("version", Some(Value::from(format_version(view.id().version)))),
        ("cluster", Some(Value::from(cluster(view.cluster())))),
        ("implements", Some(Value::from(implements))),
        ("applies", non_empty(applies)),
        ("message", Some(Value::from(names.template(view.message()?)?))),
        ("recipe", Some(document.recipe()?)),
        ("postConditions", non_empty(post_conditions)),
    ]))
}

/// `solana.org/token.transfer@^1`. The range is the shortest caret range whose lowest version is
/// the one that the implementation holds.
fn implements(
    view: &Implementation<'_>,
    interface: &Interface<'_>,
    organizations: &Organizations,
) -> Result<String, DecompileError> {
    let implements = view.implements();
    let interface_id = interface.id();
    let same_interface =
        implements.publisher == interface_id.publisher && implements.name_hash == interface_id.name_hash;

    if !same_interface || !caret_covers(implements.version, interface_id.version) {
        return Err(DecompileError::WrongInterface);
    }

    let id = document_name(implements, interface.name()?, organizations)?;

    Ok(format!("{id}@^{}", caret(implements.version)))
}

fn caret(lowest: SemverV1) -> String {
    match (lowest.major.get(), lowest.minor.get(), lowest.patch.get()) {
        (major, 0, 0) => format!("{major}"),
        (major, minor, 0) => format!("{major}.{minor}"),
        _ => format_version(lowest),
    }
}

/// A named cluster, such as `mainnet`, or the base58 genesis hash.
fn cluster(genesis_hash: &sdp_intents_spec::Address) -> String {
    sdp_intents_spec::cluster::name(genesis_hash).map_or_else(|| base58(genesis_hash), str::to_owned)
}

fn applies_hint(applies: &AppliesV1, names: &Names<'_>) -> Result<Value, DecompileError> {
    let value = Value::from(names.reference(ValueRef::try_from(applies.value)?)?);

    let hint = match AppliesKind::try_from(applies.kind)? {
        AppliesKind::Owner => {
            let length = usize::from(applies.discriminator_len);
            let discriminator = applies.discriminator.get(..length).ok_or(SpecError::BadCode)?;

            sparse_object([
                ("account", Some(value)),
                ("owner", Some(Value::from(names.address(applies.owner)?))),
                ("discriminator", (!discriminator.is_empty()).then(|| Value::from(hex(discriminator)))),
            ])
        }
        AppliesKind::InputPresent => object([("value", value), ("present", Value::Bool(true))]),
        AppliesKind::InputAbsent => object([("value", value), ("present", Value::Bool(false))]),
        AppliesKind::InputEquals => object([("value", value), ("equals", Value::from(names.address(applies.owner)?))]),
    };

    Ok(hint)
}
