//! Published documents as JSON for people: names in place of positions, and each `applies` check as
//! a sentence. A UI builds the intent form from an interface's inputs.

use serde_json::{json, Value};

use sdp_intents_spec::wire::AppliesV1;
use sdp_intents_spec::{
    Address, AppliesKind, BaseType, Implementation, Interface, RecipeKind, SpecError, ValueRef, ValueSource, ValueType,
};

/// The names that a template's positions stand for.
#[derive(Clone, Debug, Default)]
pub struct Names {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub accounts: Vec<String>,
}

impl Names {
    pub fn of_interface(view: &Interface<'_>) -> Result<Self, SpecError> {
        let text = |name| view.text(name).map(|bytes| String::from_utf8_lossy(bytes).into_owned());

        Ok(Self {
            inputs: view.inputs()?.iter().map(|input| text(input.name)).collect::<Result<_, _>>()?,
            outputs: view.outputs()?.iter().map(|output| text(output.name)).collect::<Result<_, _>>()?,
            accounts: Vec::new(),
        })
    }

    pub fn with_accounts(mut self, view: &Implementation<'_>) -> Result<Self, SpecError> {
        self.accounts = view
            .accounts()?
            .iter()
            .map(|account| view.text(account.name).map(|bytes| String::from_utf8_lossy(bytes).into_owned()))
            .collect::<Result<_, _>>()?;

        Ok(self)
    }

    /// A reference as the JSON form writes it, such as `{inputs.mint}`.
    fn reference(&self, source: ValueSource, index: u8) -> String {
        let named = |names: &[String], scope: &str| {
            names
                .get(usize::from(index))
                .map_or_else(|| format!("{{{scope}.{index}}}"), |name| format!("{{{scope}.{name}}}"))
        };

        match source {
            ValueSource::Input => named(&self.inputs, "inputs"),
            ValueSource::Output => named(&self.outputs, "outputs"),
            ValueSource::Payer if index == 0 => "{payers.fee}".to_owned(),
            ValueSource::Payer => "{payers.rent}".to_owned(),
            _ => named(&self.accounts, "accounts"),
        }
    }

    /// A compiled template with each position, such as `{i3}`, as its name.
    pub fn render(&self, template: &[u8]) -> String {
        let text = String::from_utf8_lossy(template);
        let mut rendered = String::with_capacity(text.len());
        let mut rest = text.as_ref();

        while let Some(start) = rest.find('{') {
            let (before, from_brace) = rest.split_at(start);
            rendered.push_str(before);

            if let Some(after) = from_brace.strip_prefix("{{") {
                rendered.push_str("{{");
                rest = after;
                continue;
            }

            let Some(end) = from_brace.find('}') else {
                rendered.push_str(from_brace);
                return rendered;
            };

            let (position, after) = from_brace.split_at(end);
            rendered.push_str(&self.position(position.trim_start_matches('{')));
            rest = after.get(1..).unwrap_or_default();
        }

        rendered.push_str(rest);
        rendered
    }

    fn position(&self, position: &str) -> String {
        let mut letters = position.chars();
        let source = match letters.next() {
            Some('i') => ValueSource::Input,
            Some('o') => ValueSource::Output,
            Some('p') => ValueSource::Payer,
            _ => ValueSource::Account,
        };

        match letters.as_str().parse::<u8>() {
            Ok(index) => self.reference(source, index),
            Err(_) => format!("{{{position}}}"),
        }
    }
}

pub fn interface(view: &Interface<'_>, names: &Names) -> Result<Value, SpecError> {
    let inputs = view
        .inputs()?
        .iter()
        .zip(&names.inputs)
        .map(|(input, name)| {
            let amount_mint = match input.amount_mint()? {
                ValueRef { source: ValueSource::None, .. } => None,
                mint => Some(names.reference(mint.source, mint.index)),
            };

            Ok(json!({
                "name": name,
                "type": type_name(input.value_type()?),
                "signer": input.signer(),
                "optional": input.optional(),
                "amountMint": amount_mint,
            }))
        })
        .collect::<Result<Vec<_>, SpecError>>()?;
    let outputs = view
        .outputs()?
        .iter()
        .zip(&names.outputs)
        .map(|(output, name)| Ok(json!({ "name": name, "type": type_name(output.value_type()?) })))
        .collect::<Result<Vec<_>, SpecError>>()?;
    let guarantees = view
        .post_conditions()?
        .iter()
        .map(|condition| view.text(condition.message).map(|message| names.render(message)))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(json!({
        "settlement": if view.settles_later() { "async" } else { "atomic" },
        "display": names.render(view.display()?),
        "inputs": inputs,
        "outputs": outputs,
        "postConditions": guarantees,
    }))
}

pub fn implementation(view: &Implementation<'_>, names: &Names) -> Result<Value, SpecError> {
    let applies =
        view.applies()?.iter().map(|applies| applies_text(view, applies, names)).collect::<Result<Vec<_>, _>>()?;
    let url = match view.recipe()? {
        RecipeKind::Remote | RecipeKind::RemoteTransaction => Some(String::from_utf8_lossy(view.url()?).into_owned()),
        _ => None,
    };

    Ok(json!({
        "recipe": recipe_name(view.recipe()?),
        "message": names.render(view.message()?),
        "applies": applies,
        "url": url,
    }))
}

/// One `applies` check as a sentence, such as `{inputs.mint} is owned by Tokenkeg…`.
pub fn applies_text(view: &Implementation<'_>, applies: &AppliesV1, names: &Names) -> Result<String, SpecError> {
    let value = ValueRef::try_from(applies.value)?;
    let subject = names.reference(value.source, value.index);
    let address = |index: u8| {
        view.addresses()
            .map(|addresses| addresses.get(usize::from(index)).map_or_else(|| "an unknown address".to_owned(), base58))
    };

    Ok(match AppliesKind::try_from(applies.kind)? {
        AppliesKind::Owner if applies.discriminator_len > 0 => {
            format!("{subject} is owned by {} and has its discriminator", address(applies.owner)?)
        }
        AppliesKind::Owner => format!("{subject} is owned by {}", address(applies.owner)?),
        AppliesKind::InputPresent => format!("{subject} is present"),
        AppliesKind::InputAbsent => format!("{subject} is absent"),
        AppliesKind::InputEquals => format!("{subject} is {}", address(applies.owner)?),
    })
}

pub fn recipe_name(kind: RecipeKind) -> &'static str {
    match kind {
        RecipeKind::Static => "static",
        RecipeKind::Program => "program",
        RecipeKind::Remote => "remote",
        RecipeKind::RemoteTransaction => "remote transaction",
    }
}

/// The JSON form's name of a type, such as `u64` or `address[]`.
pub fn type_name(value_type: ValueType) -> String {
    let base = match value_type.base {
        BaseType::U8 => "u8",
        BaseType::U16 => "u16",
        BaseType::U32 => "u32",
        BaseType::U64 => "u64",
        BaseType::U128 => "u128",
        BaseType::I8 => "i8",
        BaseType::I16 => "i16",
        BaseType::I32 => "i32",
        BaseType::I64 => "i64",
        BaseType::I128 => "i128",
        BaseType::Bool => "bool",
        BaseType::Address => "address",
        BaseType::Mint => "mint",
        BaseType::String => "string",
        BaseType::Bytes => "bytes",
    };

    match value_type.array {
        true => format!("{base}[]"),
        false => base.to_owned(),
    }
}

pub fn base58(address: &Address) -> String {
    bs58::encode(address.0).into_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_positions_as_names() {
        let names =
            Names { inputs: vec!["from".into(), "to".into()], outputs: vec!["shareMint".into()], accounts: vec![] };

        assert_eq!(
            names.render(b"Send to {i1} from {i0} {{literal}} {o0} {p1}"),
            "Send to {inputs.to} from {inputs.from} {{literal}} {outputs.shareMint} {payers.rent}"
        );
    }
}
