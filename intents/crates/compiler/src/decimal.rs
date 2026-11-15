//! Token amounts as decimals. An input whose display names a mint takes base units as a string,
//! such as `"1626367"`, or a decimal, `{ "decimal": "1.626367" }`. The object form is explicit, so
//! a decimal is never read as base units. The caller reads the decimals of each mint that a decimal
//! names, and the request is rewritten in base units before it compiles. The documents and
//! `verify_intent` therefore see only base units.

use sdp_intents_spec::{Address, Interface, ValueRef, ValueSource};
use serde_json::Value;

use crate::diagnostic::{Code, Diagnostic, Report};
use crate::encoding::address;
use crate::{Catalog, IdRange};

/// The System program, which names SOL as a mint.
const NATIVE_MINT: Address = Address([0; 32]);
const NATIVE_MINT_DECIMALS: u8 = 9;
/// The offset of `decimals` in an SPL Token or Token-2022 mint.
const MINT_DECIMALS: usize = 44;
const MINT_LEN: usize = 82;
/// `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` and `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`.
const TOKEN_PROGRAMS: [&str; 2] =
    ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

/// The decimals of one mint, as the caller read them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MintDecimals {
    pub mint: Address,
    pub decimals: u8,
}

/// One decimal amount of a request, and the mint that its input's display names.
struct DecimalAmount {
    pointer: String,
    mint: Address,
    text: String,
}

/// A mint account as the caller read it.
#[derive(Clone, Copy, Debug)]
pub struct MintAccount<'a> {
    pub owner: &'a Address,
    pub data: &'a [u8],
}

/// SOL's decimals for the System program, and an SPL mint's from its data. `None` when the
/// account is not a mint of Token or Token-2022.
pub fn mint_decimals(mint: &Address, account: Option<MintAccount<'_>>) -> Option<u8> {
    if mint == &NATIVE_MINT {
        return Some(NATIVE_MINT_DECIMALS);
    }

    let account = account?;
    let owned_by_a_token_program = TOKEN_PROGRAMS.iter().any(|program| address(program).ok() == Some(account.owner.0));

    (owned_by_a_token_program && account.data.len() >= MINT_LEN)
        .then(|| account.data.get(MINT_DECIMALS).copied())
        .flatten()
}

/// Each mint that a decimal amount of `request` names, once. `request` is a plan request or one
/// intent.
pub fn decimal_mints(request: &Value, catalog: &Catalog) -> Vec<Address> {
    decimal_amounts(request, catalog).amounts.into_iter().fold(Vec::new(), |mut mints, amount| {
        if !mints.contains(&amount.mint) {
            mints.push(amount.mint);
        }

        mints
    })
}

/// `request` with each decimal amount in base units, from the decimals of its mint.
pub fn with_base_units(request: &Value, catalog: &Catalog, decimals: &[MintDecimals]) -> Result<Value, Report> {
    let Found { amounts, mut diagnostics } = decimal_amounts(request, catalog);
    let mut rewritten = request.clone();

    for amount in amounts {
        let converted = decimals
            .iter()
            .find(|known| known.mint == amount.mint)
            .ok_or_else(|| format!("the decimals of mint {} are unknown", bs58::encode(amount.mint.0).into_string()))
            .and_then(|known| base_units(&amount.text, known.decimals));

        match (converted, rewritten.pointer_mut(&amount.pointer)) {
            (Ok(units), Some(slot)) => *slot = Value::from(units),
            (Err(message), _) => diagnostics.push(Diagnostic::new(Code::InvalidValue, &amount.pointer, message)),
            (Ok(_), None) => diagnostics.push(Diagnostic::new(Code::Internal, &amount.pointer, "the amount moved")),
        }
    }

    match diagnostics.is_empty() {
        true => Ok(rewritten),
        false => Err(Report { diagnostics, syntax: None }),
    }
}

/// `"1.5"` with 6 decimals is `"1500000"`. A decimal with more fractional digits than the mint has,
/// or above `u64::MAX` base units, is refused.
fn base_units(text: &str, decimals: u8) -> Result<String, String> {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let digits_only = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());

    if whole.is_empty() || !digits_only(whole) || !digits_only(fraction) || (text.contains('.') && fraction.is_empty())
    {
        return Err(format!("`{text}` is not a decimal such as `1.5`"));
    }

    if fraction.len() > usize::from(decimals) {
        return Err(format!("`{text}` has more than the mint's {decimals} decimals"));
    }

    let padded = format!("{whole}{fraction:0<width$}", width = usize::from(decimals));
    let units = padded.parse::<u64>().map_err(|_| format!("`{text}` is more base units than a u64 holds"))?;

    Ok(units.to_string())
}

/// The decimal amounts of a request, and what is wrong with the ones that cannot be read.
struct Found {
    amounts: Vec<DecimalAmount>,
    diagnostics: Vec<Diagnostic>,
}

fn decimal_amounts(request: &Value, catalog: &Catalog) -> Found {
    let intents: Vec<(String, &Value)> = match request.get("intents").and_then(Value::as_array) {
        Some(intents) => {
            intents.iter().enumerate().map(|(index, intent)| (format!("/intents/{index}"), intent)).collect()
        }
        None => vec![(String::new(), request)],
    };
    let mut found = Found { amounts: Vec::new(), diagnostics: Vec::new() };

    for (pointer, intent) in intents {
        intent_amounts(&pointer, intent, catalog, &mut found);
    }

    found
}

/// The interface tells which inputs are amounts, and the input that names each one's mint. An
/// intent whose interface is unknown is left for the compile to report.
fn intent_amounts(pointer: &str, intent: &Value, catalog: &Catalog, found: &mut Found) {
    let Some(range) = intent.get("interface").and_then(Value::as_str).and_then(|text| IdRange::parse(text).ok()) else {
        return;
    };
    let Some(compiled) = catalog.interface(&range.id.to_string()) else {
        return;
    };
    let Ok(inputs) = Interface::parse(&compiled.bytes).and_then(|interface| interface.inputs()) else {
        return;
    };
    let names: Vec<&str> = compiled.schema.inputs.iter().map(|field| field.name.as_str()).collect();
    let values = intent.get("inputs");

    for (name, input) in names.iter().zip(inputs) {
        let Some(decimal) = values.and_then(|values| values.get(*name)).and_then(|value| value.get("decimal")) else {
            continue;
        };
        let input_pointer = format!("{pointer}/inputs/{name}");
        let mint = ValueRef::try_from(input.amount_mint)
            .ok()
            .filter(|reference| reference.source == ValueSource::Input)
            .and_then(|reference| names.get(usize::from(reference.index)))
            .and_then(|mint_name| values?.get(*mint_name)?.as_str())
            .and_then(|text| address(text).ok())
            .map(Address);

        match (mint, decimal.as_str()) {
            (Some(mint), Some(text)) => {
                found.amounts.push(DecimalAmount { pointer: input_pointer, mint, text: text.to_owned() })
            }
            (None, _) => found.diagnostics.push(Diagnostic::new(
                Code::InvalidValue,
                &input_pointer,
                format!("`{name}` is not an amount of a mint that the intent names, so it takes no decimal"),
            )),
            (_, None) => found.diagnostics.push(Diagnostic::new(
                Code::WrongType,
                &input_pointer,
                "`decimal` is a string such as \"1.5\"",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_a_decimal_to_base_units() {
        assert_eq!(base_units("1.626367", 6), Ok("1626367".to_owned()));
        assert_eq!(base_units("1.5", 6), Ok("1500000".to_owned()));
        assert_eq!(base_units("2", 9), Ok("2000000000".to_owned()));
        assert_eq!(base_units("0.000001", 6), Ok("1".to_owned()));
    }

    #[test]
    fn refuses_more_decimals_than_the_mint_and_malformed_text() {
        assert!(base_units("1.0000001", 6).is_err());
        assert!(base_units("1.", 6).is_err());
        assert!(base_units(".5", 6).is_err());
        assert!(base_units("-1", 6).is_err());
        assert!(base_units("1e6", 6).is_err());
        assert!(base_units("18446744073709.551616", 6).is_err());
    }

    const USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    fn catalog() -> Catalog {
        let mut catalog = Catalog::default().with_publisher("solana.org", Address([7; 32]));
        catalog
            .compile_interface(include_str!("../../../definitions/solana.org/interfaces/token.transfer/1.0.0.json"))
            .unwrap();

        catalog
    }

    fn transfer(amount: Value, to: Value) -> Value {
        serde_json::json!({ "intents": [{
            "interface": "solana.org/token.transfer@^1",
            "inputs": { "from": USDC, "to": to, "mint": USDC, "amount": amount }
        }] })
    }

    #[test]
    fn rewrites_a_decimal_amount_in_the_base_units_of_its_mint() {
        let catalog = catalog();
        let request = transfer(serde_json::json!({ "decimal": "1.5" }), Value::from(USDC));
        let usdc = Address(address(USDC).unwrap());

        assert_eq!(decimal_mints(&request, &catalog), [usdc]);

        let rewritten = with_base_units(&request, &catalog, &[MintDecimals { mint: usdc, decimals: 6 }]).unwrap();
        assert_eq!(rewritten.pointer("/intents/0/inputs/amount"), Some(&Value::from("1500000")));

        let base_units = transfer(Value::from("1500000"), Value::from(USDC));
        assert_eq!(with_base_units(&base_units, &catalog, &[]).unwrap(), base_units);
    }

    #[test]
    fn refuses_a_decimal_on_an_input_that_is_not_an_amount() {
        let request = transfer(Value::from("1"), serde_json::json!({ "decimal": "1" }));
        let report = with_base_units(&request, &catalog(), &[]).unwrap_err();

        assert_eq!(report.diagnostics.len(), 1);
    }

    #[test]
    fn sol_has_nine_decimals_and_an_spl_mint_states_its_own() {
        let mut data = vec![0; MINT_LEN];
        data[MINT_DECIMALS] = 6;
        let token_program = Address(address(TOKEN_PROGRAMS[0]).unwrap());
        let other = Address([2; 32]);

        assert_eq!(mint_decimals(&NATIVE_MINT, None), Some(9));
        assert_eq!(mint_decimals(&Address([1; 32]), Some(MintAccount { owner: &token_program, data: &data })), Some(6));
        assert_eq!(mint_decimals(&Address([1; 32]), Some(MintAccount { owner: &other, data: &data })), None);
        assert_eq!(mint_decimals(&Address([1; 32]), None), None);
    }
}
