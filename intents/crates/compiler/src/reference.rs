//! The string forms of values and templates. A string that is exactly one reference, such as
//! `"{inputs.memo}"`, names a value. Any other string is a literal. `{{` and `}}` are literal
//! braces. A reference inside other text is valid only in a template.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Inputs,
    Outputs,
    Payers,
    Accounts,
}

impl Scope {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "inputs" => Some(Self::Inputs),
            "outputs" => Some(Self::Outputs),
            "payers" => Some(Self::Payers),
            "accounts" => Some(Self::Accounts),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inputs => "inputs",
            Self::Outputs => "outputs",
            Self::Payers => "payers",
            Self::Accounts => "accounts",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reference<'t> {
    pub scope: Scope,
    pub name: &'t str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TemplatePart<'t> {
    Text(String),
    Reference(Reference<'t>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValueText<'t> {
    Reference(Reference<'t>),
    Literal(String),
}

/// Splits a template into text and references. The text has its escapes removed.
pub fn parse_template(text: &str) -> Result<Vec<TemplatePart<'_>>, String> {
    let mut parts = Vec::new();
    let mut literal = String::new();
    let mut rest = text;

    while let Some(at) = rest.find(['{', '}']) {
        literal.push_str(rest.get(..at).unwrap_or_default());
        let tail = rest.get(at..).unwrap_or_default();

        if let Some(after) = tail.strip_prefix("{{").or_else(|| tail.strip_prefix("}}")) {
            literal.push_str(tail.get(..1).unwrap_or_default());
            rest = after;
            continue;
        }

        if tail.starts_with('}') {
            return Err("a `}` that closes nothing. Write `}}` for a literal brace.".to_owned());
        }

        let close = tail.find('}').ok_or("a `{` that is never closed. Write `{{` for a literal brace.")?;
        let reference = parse_reference(tail.get(1..close).unwrap_or_default())?;

        if !literal.is_empty() {
            parts.push(TemplatePart::Text(std::mem::take(&mut literal)));
        }

        parts.push(TemplatePart::Reference(reference));
        rest = tail.get(close.saturating_add(1)..).unwrap_or_default();
    }

    literal.push_str(rest);

    if !literal.is_empty() {
        parts.push(TemplatePart::Text(literal));
    }

    Ok(parts)
}

pub fn parse_value(text: &str) -> Result<ValueText<'_>, String> {
    let parts = parse_template(text)?;

    match parts.as_slice() {
        [] => Ok(ValueText::Literal(String::new())),
        [TemplatePart::Reference(reference)] => Ok(ValueText::Reference(*reference)),
        [TemplatePart::Text(literal)] => Ok(ValueText::Literal(literal.clone())),
        _ => Err("a reference inside other text is valid only in a template. Use the reference alone, or escape the braces as `{{` and `}}`.".to_owned()),
    }
}

fn parse_reference(inner: &str) -> Result<Reference<'_>, String> {
    let (scope, name) = inner.split_once('.').ok_or_else(|| {
        format!("`{{{inner}}}` is not a reference. A reference is `{{scope.name}}`, such as `{{inputs.amount}}`.")
    })?;
    let scope = Scope::parse(scope).ok_or_else(|| {
        format!("`{scope}` is not a scope. The scopes are `inputs`, `outputs`, `payers`, and `accounts`.")
    })?;

    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("`{name}` is not a name. A name has letters, digits, and `_`."));
    }

    Ok(Reference { scope, name })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(scope: Scope, name: &str) -> Reference<'_> {
        Reference { scope, name }
    }

    #[test]
    fn a_lone_reference_is_a_value() {
        assert_eq!(parse_value("{inputs.memo}"), Ok(ValueText::Reference(reference(Scope::Inputs, "memo"))));
        assert_eq!(parse_value("scratch"), Ok(ValueText::Literal("scratch".to_owned())));
        assert_eq!(parse_value("{{inputs.memo}}"), Ok(ValueText::Literal("{inputs.memo}".to_owned())));
        assert!(parse_value("pre {inputs.memo}").is_err());
    }

    #[test]
    fn a_template_mixes_text_and_references() {
        assert_eq!(
            parse_template("Send {inputs.amount} to {inputs.to}"),
            Ok(vec![
                TemplatePart::Text("Send ".to_owned()),
                TemplatePart::Reference(reference(Scope::Inputs, "amount")),
                TemplatePart::Text(" to ".to_owned()),
                TemplatePart::Reference(reference(Scope::Inputs, "to")),
            ])
        );
    }

    #[test]
    fn explains_each_mistake() {
        assert!(parse_template("{inputs.amount").unwrap_err().contains("never closed"));
        assert!(parse_template("amount}").unwrap_err().contains("closes nothing"));
        assert!(parse_template("{input.amount}").unwrap_err().contains("not a scope"));
        assert!(parse_template("{amount}").unwrap_err().contains("not a reference"));
    }
}
