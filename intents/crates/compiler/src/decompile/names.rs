//! Names in place of positions: a `ValueRef` becomes `{inputs.amount}`, and a compiled template
//! becomes the template that JSON writes.

use sdp_intents_spec::{Address, Interface, SpecError, ValueRef, ValueSource};

use super::json::{base58, utf8};
use super::DecompileError;

const PAYERS: [&str; 2] = ["fee", "rent"];

/// The names that a reference in one document can resolve to.
pub(super) struct Names<'d> {
    pub(super) inputs: Vec<String>,
    pub(super) outputs: Vec<String>,
    pub(super) accounts: Vec<String>,
    pub(super) addresses: &'d [Address],
}

impl<'d> Names<'d> {
    pub(super) fn new(
        interface: &Interface<'_>,
        accounts: Vec<String>,
        addresses: &'d [Address],
    ) -> Result<Self, DecompileError> {
        let text = |name| interface.text(name).map_err(DecompileError::from).and_then(utf8).map(str::to_owned);

        Ok(Self {
            inputs: interface.inputs()?.iter().map(|input| text(input.name)).collect::<Result<_, _>>()?,
            outputs: interface.outputs()?.iter().map(|output| text(output.name)).collect::<Result<_, _>>()?,
            accounts,
            addresses,
        })
    }

    /// A reference such as `{inputs.amount}`. An address or a literal has no reference.
    pub(super) fn reference(&self, value: ValueRef) -> Result<String, DecompileError> {
        let index = value.index;

        match value.source {
            ValueSource::Input => scoped("inputs", &self.inputs, index),
            ValueSource::Output => scoped("outputs", &self.outputs, index),
            ValueSource::Account => scoped("accounts", &self.accounts, index),
            ValueSource::Payer => PAYERS
                .get(usize::from(index))
                .map(|payer| format!("{{payers.{payer}}}"))
                .ok_or(DecompileError::Spec(SpecError::BadIndex)),
            ValueSource::Bumps if index == 0 => Ok("{builder.bumps}".to_owned()),
            ValueSource::Bumps => Err(DecompileError::Spec(SpecError::BadIndex)),
            ValueSource::Address | ValueSource::Literal | ValueSource::None => {
                Err(DecompileError::Unrepresentable("an address, a literal, or nothing where a reference must be"))
            }
        }
    }

    /// A reference, or the base58 text of an address from the addresses table.
    pub(super) fn value(&self, value: ValueRef) -> Result<String, DecompileError> {
        match value.source {
            ValueSource::Address => self.address(value.index),
            _ => self.reference(value),
        }
    }

    pub(super) fn address(&self, index: u8) -> Result<String, DecompileError> {
        self.addresses.get(usize::from(index)).map(base58).ok_or(DecompileError::Spec(SpecError::BadIndex))
    }

    /// An account's name, as an instruction's account list or an output binding writes it.
    pub(super) fn account(&self, index: u8) -> Result<&str, DecompileError> {
        unique_name(&self.accounts, index)
    }

    /// `{accounts.vault}`.
    pub(super) fn account_reference(&self, index: u8) -> Result<String, DecompileError> {
        scoped("accounts", &self.accounts, index)
    }

    pub(super) fn output(&self, index: u8) -> Result<&str, DecompileError> {
        unique_name(&self.outputs, index)
    }

    /// Turns `{i3}` back into `{inputs.amount}`. The compiler writes literal braces as `{{` and `}}`,
    /// and a template keeps them so.
    pub(super) fn template(&self, bytes: &[u8]) -> Result<String, DecompileError> {
        let mut rest = utf8(bytes)?;
        let mut template = String::with_capacity(rest.len());

        while let Some(at) = rest.find(['{', '}']) {
            let (text, tail) = rest.split_at_checked(at).ok_or(DecompileError::BadTemplate)?;
            template.push_str(text);

            if let Some(after) = tail.strip_prefix("{{").or_else(|| tail.strip_prefix("}}")) {
                template.push_str(tail.get(..2).unwrap_or_default());
                rest = after;
                continue;
            }

            let opened = tail.strip_prefix('{').ok_or(DecompileError::BadTemplate)?;
            let (placeholder, after) = opened.split_once('}').ok_or(DecompileError::BadTemplate)?;
            template.push_str(&self.reference(placeholder_value(placeholder)?)?);
            rest = after;
        }

        template.push_str(rest);

        Ok(template)
    }
}

/// `i3` is input 3. The compiler writes the index in decimal with no leading zero.
fn placeholder_value(placeholder: &str) -> Result<ValueRef, DecompileError> {
    let mut chars = placeholder.chars();
    let source = match chars.next() {
        Some('i') => ValueSource::Input,
        Some('o') => ValueSource::Output,
        Some('p') => ValueSource::Payer,
        Some('a') => ValueSource::Account,
        _ => return Err(DecompileError::BadTemplate),
    };
    let digits = chars.as_str();
    let index: u8 = digits.parse().map_err(|_| DecompileError::BadTemplate)?;

    if index.to_string() != digits {
        return Err(DecompileError::BadTemplate);
    }

    Ok(ValueRef { source, index })
}

/// A reference resolves a name to its first entry, so a name that an earlier entry also uses
/// cannot name this entry.
fn unique_name(names: &[String], index: u8) -> Result<&str, DecompileError> {
    let position = usize::from(index);
    let name = names.get(position).ok_or(DecompileError::Spec(SpecError::BadIndex))?;

    if names.iter().position(|known| known == name) != Some(position) {
        return Err(DecompileError::Unrepresentable("a reference to a name that an earlier entry also uses"));
    }

    Ok(name)
}

fn scoped(scope: &str, names: &[String], index: u8) -> Result<String, DecompileError> {
    let name = unique_name(names, index)?;

    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(DecompileError::Unrepresentable(
            "a reference to a name with a character other than a letter, a digit, or `_`",
        ));
    }

    Ok(format!("{{{scope}.{name}}}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(accounts: &[&str]) -> Names<'static> {
        Names {
            inputs: vec!["amount".to_owned()],
            outputs: Vec::new(),
            accounts: accounts.iter().map(|name| (*name).to_owned()).collect(),
            addresses: &[],
        }
    }

    #[test]
    fn a_template_gets_its_names_and_keeps_its_escapes() {
        let names = names(&["vault"]);

        assert_eq!(names.template(b"{{x}} {i0} to {a0}").unwrap(), "{{x}} {inputs.amount} to {accounts.vault}");
        assert_eq!(names.template(b"{p1}").unwrap(), "{payers.rent}");
    }

    #[test]
    fn refuses_a_placeholder_that_templates_do_not_have() {
        let names = names(&[]);

        assert_eq!(names.template(b"{x0}"), Err(DecompileError::BadTemplate));
        assert_eq!(names.template(b"{i01}"), Err(DecompileError::BadTemplate));
        assert_eq!(names.template(b"a } b"), Err(DecompileError::BadTemplate));
        assert_eq!(names.template(b"{i0"), Err(DecompileError::BadTemplate));
        assert_eq!(names.template(b"{i1}"), Err(DecompileError::Spec(SpecError::BadIndex)));
    }

    #[test]
    fn refuses_a_reference_that_resolves_to_an_earlier_entry() {
        let names = names(&["vault", "vault", "my-vault"]);

        assert!(names.template(b"{a0}").is_ok());
        assert!(matches!(names.template(b"{a1}"), Err(DecompileError::Unrepresentable(_))));
        assert!(matches!(names.template(b"{a2}"), Err(DecompileError::Unrepresentable(_))));
        assert_eq!(names.account(2), Ok("my-vault"));
    }
}
