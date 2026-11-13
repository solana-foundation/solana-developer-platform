//! Names in place of positions, for the sentences that the service writes about a document: each
//! `applies` check, and the recipe kind.

use sdp_intents_spec::wire::AppliesV1;
use sdp_intents_spec::{Address, AppliesKind, Implementation, Interface, RecipeKind, SpecError, ValueRef, ValueSource};

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

pub fn base58(address: &Address) -> String {
    bs58::encode(address.0).into_string()
}
