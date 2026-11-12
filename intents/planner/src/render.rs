//! Renders a compiled template, such as `Send {i3} {i2} to {i1}`, in one of two columns.
//!
//! The message is what a signer reads and signs. It names tokens by mint address, because anyone
//! can name a token "USDC", and it refuses text that is not printable ASCII, so that no character
//! can look like another. The display is for people, and shortens addresses. `DESIGN.md`, section
//! 4.5, gives the rules.

use sdp_intents_engine::Chain;
use sdp_intents_spec::{Address, BaseType};

use crate::values::{Typed, Value, Values};
use crate::PlanError;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Column {
    Message,
    Display,
}

impl<C: Chain> Values<'_, '_, C> {
    pub(crate) fn render(&self, template: &[u8], column: Column) -> Result<String, PlanError> {
        let mut out = String::new();
        let mut rest = template;

        while !rest.is_empty() {
            let run = rest.iter().position(|byte| matches!(byte, b'{' | b'}')).unwrap_or(rest.len());
            let (text, tail) = rest.split_at(run);
            out.push_str(core::str::from_utf8(text).map_err(|_| PlanError::BadTemplate)?);

            rest = match tail {
                [b'{', b'{', after @ ..] => {
                    out.push('{');
                    after
                }
                [b'}', b'}', after @ ..] => {
                    out.push('}');
                    after
                }
                [b'{', after @ ..] => {
                    let end = after.iter().position(|byte| *byte == b'}').ok_or(PlanError::BadTemplate)?;
                    let (placeholder, after) = after.split_at(end);
                    out.push_str(&self.placeholder(placeholder, column)?);
                    after.get(1..).unwrap_or_default()
                }
                [] => tail,
                _ => return Err(PlanError::BadTemplate),
            };
        }

        Ok(out)
    }

    /// `i3` is input 3, `o0` is output 0, `p0` is the fee payer, and `a2` is account 2.
    fn placeholder(&self, placeholder: &[u8], column: Column) -> Result<String, PlanError> {
        let (letter, digits) = placeholder.split_first().ok_or(PlanError::BadTemplate)?;
        let index: u8 =
            core::str::from_utf8(digits).ok().and_then(|digits| digits.parse().ok()).ok_or(PlanError::BadTemplate)?;

        let typed = match letter {
            b'i' => self.input(index)?,
            b'o' => self.output(index)?,
            b'p' if index == 0 => address(*self.recipe.intent().fee_payer()),
            b'p' => address(*self.recipe.intent().rent_payer()),
            b'a' => address(*self.recipe.address(index).ok_or(PlanError::Unresolved)?),
            _ => return Err(PlanError::BadTemplate),
        };

        render_value(&typed.value, typed.base, typed.decimals, column)
    }
}

fn address<'v>(address: Address) -> Typed<'v> {
    Typed { value: Value::Address(address), base: BaseType::Address, decimals: None }
}

fn render_value(value: &Value<'_>, base: BaseType, decimals: Option<u8>, column: Column) -> Result<String, PlanError> {
    let rendered = match value {
        Value::Absent if column == Column::Message => "none".to_owned(),
        Value::Absent => String::new(),
        Value::Unsigned(integer) => with_decimals(integer.to_string(), decimals),
        Value::Signed(integer) if *integer < 0 => {
            format!("-{}", with_decimals(integer.unsigned_abs().to_string(), decimals))
        }
        Value::Signed(integer) => with_decimals(integer.to_string(), decimals),
        Value::Bool(value) => value.to_string(),
        Value::Address(address)
            if column == Column::Display && base == BaseType::Mint && *address == Address::default() =>
        {
            "SOL".to_owned()
        }
        Value::Address(address) if column == Column::Display && base == BaseType::Address => {
            shortened(&base58(address))
        }
        Value::Address(address) => base58(address),
        Value::Text(text) if column == Column::Message && !text.bytes().all(|byte| (b' '..=b'~').contains(&byte)) => {
            return Err(PlanError::UnsafeText);
        }
        Value::Text(text) => (*text).to_owned(),
        Value::Bytes(bytes) => bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
        Value::List(items) => {
            let items =
                items.iter().map(|item| render_value(item, base, decimals, column)).collect::<Result<Vec<_>, _>>()?;
            format!("[{}]", items.join(", "))
        }
    };

    Ok(rendered)
}

pub(crate) fn base58(address: &Address) -> String {
    bs58::encode(address.0).into_string()
}

/// The first and the last 4 characters.
fn shortened(text: &str) -> String {
    let head: String = text.chars().take(4).collect();
    let tail: String = text.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();

    format!("{head}…{tail}")
}

/// `100000000` with 6 decimals is `100`, and `1500000` is `1.5`.
fn with_decimals(digits: String, decimals: Option<u8>) -> String {
    let Some(decimals) = decimals.map(usize::from).filter(|decimals| *decimals > 0) else {
        return digits;
    };

    let padded = format!("{digits:0>width$}", width = decimals.saturating_add(1));
    let (whole, fraction) = padded.split_at(padded.len().saturating_sub(decimals));
    let fraction = fraction.trim_end_matches('0');

    if fraction.is_empty() {
        whole.to_owned()
    } else {
        format!("{whole}.{fraction}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_amount_drops_trailing_zeros() {
        assert_eq!(with_decimals("100000000".into(), Some(6)), "100");
        assert_eq!(with_decimals("1500000".into(), Some(6)), "1.5");
        assert_eq!(with_decimals("5".into(), Some(9)), "0.000000005");
        assert_eq!(with_decimals("42".into(), None), "42");
    }

    #[test]
    fn the_display_shortens_an_address_and_names_sol() {
        let address = Address([1; 32]);
        let rendered = render_value(&Value::Address(address), BaseType::Address, None, Column::Display).unwrap();

        assert_eq!(rendered.chars().count(), 9);
        assert_eq!(
            render_value(&Value::Address(Address::default()), BaseType::Mint, None, Column::Display).unwrap(),
            "SOL"
        );
        assert_eq!(
            render_value(&Value::Address(address), BaseType::Address, None, Column::Message).unwrap(),
            base58(&address)
        );
    }

    #[test]
    fn the_message_refuses_text_that_can_look_like_other_text() {
        assert_eq!(
            render_value(&Value::Text("pay Аlice"), BaseType::String, None, Column::Message),
            Err(PlanError::UnsafeText)
        );
        assert_eq!(
            render_value(&Value::Text("pay Аlice"), BaseType::String, None, Column::Display).unwrap(),
            "pay Аlice"
        );
        assert_eq!(render_value(&Value::Absent, BaseType::String, None, Column::Message).unwrap(), "none");
    }
}
