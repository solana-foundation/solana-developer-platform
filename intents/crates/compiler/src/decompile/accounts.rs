//! The account table, the address sources of its entries, and the segments of data and seeds.

use sdp_intents_spec::wire::{AccountV1, SegmentV1};
use sdp_intents_spec::{AddressSource, Segment, SpecError};
use serde_json::Value;

use super::implementation::Document;
use super::json::{encoding_name, flag, literal, object, sparse_object, utf8, LiteralPlace};
use super::DecompileError;

impl Document<'_, '_> {
    /// The first `declared` accounts of the table.
    pub(super) fn accounts(&self, declared: usize) -> Result<Vec<Value>, DecompileError> {
        let accounts = self.view.accounts()?.get(..declared).ok_or(SpecError::OutOfBounds)?;

        accounts.iter().map(|account| self.account(account)).collect()
    }

    /// The flags come before an address object and after an address text, as the definitions write
    /// them.
    fn account(&self, account: &AccountV1) -> Result<Value, DecompileError> {
        let name = Some(Value::from(utf8(self.view.text(account.name)?)?));
        let address = self.address_source(account.address()?)?;
        let writable = flag(account.writable());
        let signer = flag(account.signer());

        if address.is_object() {
            return Ok(sparse_object([
                ("name", name),
                ("writable", writable),
                ("signer", signer),
                ("address", Some(address)),
            ]));
        }

        Ok(sparse_object([("name", name), ("address", Some(address)), ("writable", writable), ("signer", signer)]))
    }

    fn address_source(&self, source: AddressSource) -> Result<Value, DecompileError> {
        let names = self.names;

        let address = match source {
            AddressSource::Value(value) => Value::from(names.value(value)?),
            AddressSource::Static { address } => Value::from(names.address(address)?),
            AddressSource::Pda { program, seeds } => {
                let seeds: Vec<Value> = self
                    .view
                    .seeds(seeds)?
                    .iter()
                    .map(|seed| self.segment(seed, LiteralPlace::Seed))
                    .collect::<Result<_, _>>()?;

                object([(
                    "pda",
                    object([("program", Value::from(names.value(program)?)), ("seeds", Value::Array(seeds))]),
                )])
            }
            AddressSource::Ata { owner, mint, token_program } => object([(
                "ata",
                object([
                    ("owner", Value::from(names.value(owner)?)),
                    ("mint", Value::from(names.value(mint)?)),
                    ("tokenProgram", Value::from(names.value(token_program)?)),
                ]),
            )]),
            AddressSource::HasOne { account, owner, offset } => object([(
                "hasOne",
                object([
                    ("account", Value::from(names.account_reference(account)?)),
                    ("owner", Value::from(names.address(owner)?)),
                    ("offset", Value::from(offset.to_string())),
                ]),
            )]),
        };

        Ok(address)
    }

    pub(super) fn segment(&self, segment: &SegmentV1, place: LiteralPlace) -> Result<Value, DecompileError> {
        let names = self.names;

        let segment = match segment.decode()? {
            Segment::Literal(bytes) => literal(self.view.text(bytes)?, place),
            Segment::Reference { value, encoding } => object([
                ("value", Value::from(names.reference(value)?)),
                ("encoding", Value::from(encoding_name(encoding)?)),
            ]),
            Segment::AccountBytes { account, owner, offset, length } => object([(
                "read",
                object([
                    ("account", Value::from(names.account_reference(account)?)),
                    ("owner", Value::from(names.address(owner)?)),
                    ("offset", Value::from(offset.to_string())),
                    ("length", Value::from(length.to_string())),
                ]),
            )]),
        };

        Ok(segment)
    }
}
