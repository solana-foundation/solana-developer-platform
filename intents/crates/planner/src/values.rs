//! Reads the values that templates and postconditions name: the intent's inputs, the recipe's
//! outputs, the payers, the accounts, and the static addresses. Inputs and outputs are borsh.

use sdp_intents_engine::{Chain, Recipe};
use sdp_intents_spec::{Address, BaseType, SpecError, ValueRef, ValueSource, ValueType};

use crate::PlanError;

/// SOL has 9 decimals, and an interface names it by the System program's address.
const SOL_DECIMALS: u8 = 9;
/// A mint's decimals are byte 44 of its data, for SPL Token and Token-2022.
const MINT_DECIMALS_OFFSET: usize = 44;

/// The document whose address table a `ValueRef` with source `Address` indexes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Table {
    Interface,
    Implementation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Value<'v> {
    Absent,
    Unsigned(u128),
    Signed(i128),
    Bool(bool),
    Address(Address),
    Text(&'v str),
    Bytes(&'v [u8]),
    List(Vec<Value<'v>>),
}

/// A value with what rendering needs: its type, and the decimals of an `amount` display.
pub(crate) struct Typed<'v> {
    pub(crate) value: Value<'v>,
    pub(crate) base: BaseType,
    pub(crate) decimals: Option<u8>,
}

pub(crate) struct Values<'r, 'a, C> {
    pub(crate) recipe: &'r Recipe<'a>,
    pub(crate) chain: &'r C,
    /// The interface's outputs, in order, in borsh.
    pub(crate) outputs: &'r [u8],
}

impl<'r, C: Chain> Values<'r, '_, C> {
    pub(crate) fn input(&self, index: u8) -> Result<Typed<'r>, PlanError> {
        let inputs = self.recipe.interface().inputs()?;
        let input = inputs.get(usize::from(index)).ok_or(SpecError::BadIndex)?;
        let value_type = input.value_type()?;
        let value = Reader(self.recipe.intent().input(index)?).read(value_type, input.optional())?;
        let mint = input.amount_mint()?;
        let decimals = match mint.source {
            ValueSource::None => None,
            _ => Some(self.decimals(&self.address(mint, Table::Interface)?)?),
        };

        Ok(Typed { value, base: value_type.base, decimals })
    }

    pub(crate) fn output(&self, index: u8) -> Result<Typed<'r>, PlanError> {
        let mut reader = Reader(self.outputs);
        let mut found = None;

        for (output, position) in self.recipe.interface().outputs()?.iter().zip(0u8..) {
            let value = reader.read(output.value_type()?, false)?;

            if position == index {
                found = Some(Typed { value, base: output.value_type()?.base, decimals: None });
            }
        }

        found.ok_or(PlanError::Spec(SpecError::BadIndex))
    }

    pub(crate) fn address(&self, value: ValueRef, table: Table) -> Result<Address, PlanError> {
        let index = value.index;
        let typed = match value.source {
            ValueSource::Input => self.input_value(index)?,
            ValueSource::Output => self.output(index)?.value,
            ValueSource::Payer if index == 0 => Value::Address(*self.recipe.payers().fee),
            ValueSource::Payer => Value::Address(*self.recipe.payers().rent),
            ValueSource::Account => Value::Address(*self.recipe.address(index).ok_or(PlanError::Unresolved)?),
            ValueSource::Address => Value::Address(self.static_address(index, table)?),
            ValueSource::None | ValueSource::Literal | ValueSource::Bumps => Value::Absent,
        };

        match typed {
            Value::Address(address) => Ok(address),
            _ => Err(PlanError::Spec(SpecError::BadCode)),
        }
    }

    pub(crate) fn integer(&self, value: ValueRef) -> Result<u128, PlanError> {
        let typed = match value.source {
            ValueSource::Input => self.input_value(value.index)?,
            ValueSource::Output => self.output(value.index)?.value,
            _ => Value::Absent,
        };

        match typed {
            Value::Unsigned(integer) => Ok(integer),
            _ => Err(PlanError::Spec(SpecError::BadCode)),
        }
    }

    /// The mints of the inputs with an `amount` display, which rendering reads the decimals of.
    pub(crate) fn amount_mints(&self) -> Result<Vec<Address>, PlanError> {
        self.recipe
            .interface()
            .inputs()?
            .iter()
            .filter_map(|input| input.amount_mint().ok().filter(|mint| mint.source != ValueSource::None))
            .map(|mint| self.address(mint, Table::Interface))
            .filter(|address| address.as_ref().map_or(true, |address| *address != Address::default()))
            .collect()
    }

    /// The mints of the amounts that an input names. A mint that an output names is not known
    /// before the recipe runs.
    pub(crate) fn input_mints(&self) -> Result<Vec<Address>, PlanError> {
        let inputs = self.recipe.interface().inputs()?;
        let mints =
            inputs.iter().filter_map(|input| input.amount_mint().ok()).filter(|mint| mint.source == ValueSource::Input);

        mints.map(|mint| self.address(mint, Table::Interface)).collect()
    }

    /// The organization that publishes each document.
    pub(crate) fn publishers(&self) -> [Address; 2] {
        [self.recipe.interface().id().publisher, self.recipe.implementation().id().publisher]
    }

    /// The accounts that the message reads: the mint of each amount, and the organization that
    /// publishes each document.
    pub(crate) fn message_accounts(&self) -> Result<Vec<Address>, PlanError> {
        Ok(self.amount_mints()?.into_iter().chain(self.publishers()).collect())
    }

    /// The name of the organization at `publisher`. The registry owns the account, and the
    /// account's address derives from the name, so the name cannot belong to another organization.
    pub(crate) fn organization(&self, publisher: &Address) -> Result<String, PlanError> {
        let account = self.chain.account(publisher).ok_or(PlanError::Unresolved)?;
        let not_organization = || PlanError::NotAnOrganization(*publisher);

        if *account.owner != sdp_intents_registry_client::REGISTRY_PROGRAM {
            return Err(not_organization());
        }

        let view =
            sdp_intents_registry_client::OrganizationView::parse(account.data).map_err(|_| not_organization())?;
        let name = view.name().map_err(|_| not_organization())?;

        match sdp_intents_registry_client::organization_address(name) {
            Ok(address) if address == *publisher => Ok(name.to_owned()),
            _ => Err(not_organization()),
        }
    }

    pub(crate) fn decimals(&self, mint: &Address) -> Result<u8, PlanError> {
        if *mint == Address::default() {
            return Ok(SOL_DECIMALS);
        }

        let account = self.chain.account(mint).ok_or(PlanError::Unresolved)?;

        account.data.get(MINT_DECIMALS_OFFSET).copied().ok_or(PlanError::NotAMint(*mint))
    }

    /// Reads an input without its amount display, so that a mint reads without its own decimals.
    fn input_value(&self, index: u8) -> Result<Value<'r>, PlanError> {
        let inputs = self.recipe.interface().inputs()?;
        let input = inputs.get(usize::from(index)).ok_or(SpecError::BadIndex)?;

        Reader(self.recipe.intent().input(index)?).read(input.value_type()?, input.optional())
    }

    fn static_address(&self, index: u8, table: Table) -> Result<Address, PlanError> {
        let addresses = match table {
            Table::Interface => self.recipe.interface().addresses()?,
            Table::Implementation => self.recipe.implementation().addresses()?,
        };

        addresses.get(usize::from(index)).copied().ok_or(PlanError::Spec(SpecError::BadIndex))
    }
}

/// Reads borsh values from the front of some bytes. `Recipe::bind` checked every input, so a read
/// fails only on outputs that a builder wrote wrong.
pub(crate) struct Reader<'v>(pub(crate) &'v [u8]);

impl<'v> Reader<'v> {
    pub(crate) fn read(&mut self, value_type: ValueType, optional: bool) -> Result<Value<'v>, PlanError> {
        if optional && self.take(1)? == [0] {
            return Ok(Value::Absent);
        }

        if !value_type.array {
            return self.base(value_type.base);
        }

        let count = self.length()?;
        let items = (0..count).map(|_| self.base(value_type.base)).collect::<Result<Vec<_>, _>>()?;

        Ok(Value::List(items))
    }

    fn base(&mut self, base: BaseType) -> Result<Value<'v>, PlanError> {
        let value = match base {
            BaseType::Bool => Value::Bool(self.take(1)? == [1]),
            BaseType::Address | BaseType::Mint => Value::Address(Address(self.array()?)),
            BaseType::String => {
                let len = self.length()?;
                Value::Text(core::str::from_utf8(self.take(len)?).map_err(|_| SpecError::BadCode)?)
            }
            BaseType::Bytes => {
                let len = self.length()?;
                Value::Bytes(self.take(len)?)
            }
            BaseType::U8 | BaseType::U16 | BaseType::U32 | BaseType::U64 | BaseType::U128 => {
                Value::Unsigned(u128::from_le_bytes(widen(self.take(width(base))?, 0)?))
            }
            BaseType::I8 | BaseType::I16 | BaseType::I32 | BaseType::I64 | BaseType::I128 => {
                let bytes = self.take(width(base))?;
                let fill = if bytes.last().is_some_and(|top| top & 0x80 != 0) { 0xff } else { 0 };

                Value::Signed(i128::from_le_bytes(widen(bytes, fill)?))
            }
        };

        Ok(value)
    }

    fn array(&mut self) -> Result<[u8; 32], PlanError> {
        self.take(32)?.try_into().map_err(|_| PlanError::Spec(SpecError::Truncated))
    }

    fn length(&mut self) -> Result<usize, PlanError> {
        let bytes: [u8; 4] = self.take(4)?.try_into().map_err(|_| SpecError::Truncated)?;

        usize::try_from(u32::from_le_bytes(bytes)).map_err(|_| PlanError::Spec(SpecError::OutOfBounds))
    }

    fn take(&mut self, len: usize) -> Result<&'v [u8], PlanError> {
        let (taken, rest) = self.0.split_at_checked(len).ok_or(SpecError::Truncated)?;
        self.0 = rest;

        Ok(taken)
    }
}

fn widen(bytes: &[u8], fill: u8) -> Result<[u8; 16], PlanError> {
    let mut wide = [fill; 16];
    wide.get_mut(..bytes.len()).ok_or(SpecError::OutOfBounds)?.copy_from_slice(bytes);

    Ok(wide)
}

fn width(base: BaseType) -> usize {
    match base {
        BaseType::U8 | BaseType::I8 => 1,
        BaseType::U16 | BaseType::I16 => 2,
        BaseType::U32 | BaseType::I32 => 4,
        BaseType::U64 | BaseType::I64 => 8,
        _ => 16,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_borsh_values() {
        let string = ValueType { base: BaseType::String, array: false };
        let signed = ValueType { base: BaseType::I16, array: false };
        let list = ValueType { base: BaseType::U8, array: true };

        assert_eq!(Reader(&[0]).read(string, true), Ok(Value::Absent));
        assert_eq!(Reader(&[1, 2, 0, 0, 0, b'h', b'i']).read(string, true), Ok(Value::Text("hi")));
        assert_eq!(Reader(&[0xfe, 0xff]).read(signed, false), Ok(Value::Signed(-2)));
        assert_eq!(
            Reader(&[2, 0, 0, 0, 7, 8]).read(list, false),
            Ok(Value::List(vec![Value::Unsigned(7), Value::Unsigned(8)]))
        );
        assert!(Reader(&[1]).read(signed, false).is_err());
    }
}
