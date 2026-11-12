//! The account table, and the address sources that its entries use.

use sdp_intents_spec::{AccountV1, AddressSource, BaseType, RangeV1, ValueRef, ValueSource};

use super::Build;
use crate::diagnostic::{Code, Diagnostic};
use crate::encoding::address;
use crate::envelope::reported;
use crate::reader::{Node, Sink};
use crate::reference::{parse_value, Reference, Scope, ValueText};
use crate::scope::{Allowed, Names};

/// Whether the table is a builder's accounts. A builder's accounts are readonly, never sign, and
/// never name a payer.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Table {
    Static,
    Builder,
}

impl Build<'_, '_> {
    pub(super) fn read_accounts(&mut self, node: &Node<'_>, table: Table) {
        let Some(nodes) = node.array(self.sink) else {
            return;
        };

        nodes.iter().for_each(|account| self.read_account(account, table));
    }

    /// A failed entry still takes its place in the table, so that later indexes stay right.
    fn read_account(&mut self, node: &Node<'_>, table: Table) {
        let Some(mut object) = node.object(self.sink) else {
            self.push_account(String::new(), AccountV1::default());
            return;
        };

        let name_node = object.required("name", self.sink);
        let name = name_node.as_ref().and_then(|name| name.str(self.sink)).unwrap_or_default().to_owned();
        let writable = self.read_flag(object.field("writable"), table, Code::BuilderAccountWritable);
        let signer = self.read_flag(object.field("signer"), table, Code::BuilderAccountSigner);
        let address = object.required("address", self.sink).and_then(|address| self.read_address(&address, table));
        object.finish(self.sink);

        if let Some(name_node) = name_node.filter(|_| self.account_names.contains(&name)) {
            self.sink.push(Diagnostic::new(
                Code::DuplicateName,
                &name_node.pointer,
                format!("the account `{name}` is already in the table"),
            ));
        }

        let account = address.map(|address| AccountV1::new(self.pool.add(name.as_bytes()), writable, signer, address));
        self.push_account(name, account.unwrap_or_default());
    }

    pub(super) fn push_account(&mut self, name: String, account: AccountV1) {
        self.accounts.push(account);
        self.account_names.push(name);
    }

    fn read_flag(&mut self, node: Option<Node<'_>>, table: Table, builder_code: Code) -> bool {
        let Some(node) = node else {
            return false;
        };
        let value = node.bool(self.sink).unwrap_or(false);

        if value && table == Table::Builder {
            let flag = node.pointer.rsplit('/').next().unwrap_or_default().to_owned();

            self.sink.push(
                Diagnostic::new(builder_code, &node.pointer, format!("a builder account cannot be `{flag}`")).help(
                    "a builder only reads accounts. Name the account in the instructions that the builder returns.",
                ),
            );
        }

        value
    }

    fn read_address(&mut self, node: &Node<'_>, table: Table) -> Option<AddressSource> {
        let visible = self.accounts.len();

        if !node.is_object() {
            return match self.read_value(node, visible, table)? {
                ValueRef { source: ValueSource::Address, index } => Some(AddressSource::Static { address: index }),
                value => Some(AddressSource::Value(value)),
            };
        }

        let mut object = node.object(self.sink)?;
        let Some(kind) = object.only_key_except("") else {
            self.sink.push(
                Diagnostic::new(Code::InvalidValue, &node.pointer, "an address object names its source")
                    .help("the sources are `pda`, `ata`, and `hasOne`"),
            );
            return None;
        };

        let source = match kind {
            "pda" => object.required("pda", self.sink).and_then(|pda| self.read_pda(&pda, visible, table)),
            "ata" => object.required("ata", self.sink).and_then(|ata| self.read_ata(&ata, visible, table)),
            "hasOne" => object.required("hasOne", self.sink).and_then(|has_one| self.read_has_one(&has_one, visible)),
            _ => None,
        };
        object.finish(self.sink);

        source
    }

    fn read_pda(&mut self, node: &Node<'_>, visible: usize, table: Table) -> Option<AddressSource> {
        let mut object = node.object(self.sink)?;
        let program =
            object.required("program", self.sink).and_then(|program| self.read_value(&program, visible, table));
        let seeds = object.required("seeds", self.sink).and_then(|seeds| seeds.array(self.sink));
        object.finish(self.sink);

        let first = self.seeds.len();
        let seeds: Vec<_> = seeds?.iter().filter_map(|seed| self.read_segment(seed, visible)).collect();
        self.seeds.extend(seeds);

        let range = RangeV1 {
            first: u8::try_from(first).ok()?,
            count: u8::try_from(self.seeds.len().saturating_sub(first)).ok()?,
        };

        Some(AddressSource::Pda { program: program?, seeds: range })
    }

    fn read_ata(&mut self, node: &Node<'_>, visible: usize, table: Table) -> Option<AddressSource> {
        let mut object = node.object(self.sink)?;
        let owner = object.required("owner", self.sink).and_then(|owner| self.read_value(&owner, visible, table));
        let mint = object.required("mint", self.sink).and_then(|mint| self.read_value(&mint, visible, table));
        let token_program =
            object.required("tokenProgram", self.sink).and_then(|program| self.read_value(&program, visible, table));
        object.finish(self.sink);

        Some(AddressSource::Ata { owner: owner?, mint: mint?, token_program: token_program? })
    }

    /// `{ "account": "{accounts.vault}", "owner": "…", "offset": "8" }`.
    fn read_has_one(&mut self, node: &Node<'_>, visible: usize) -> Option<AddressSource> {
        let mut object = node.object(self.sink)?;
        let account =
            object.required("account", self.sink).and_then(|account| self.read_account_index(&account, visible));
        let owner = object.required("owner", self.sink).and_then(|owner| self.read_literal_address(&owner));
        let offset = object.required("offset", self.sink).and_then(|offset| read_integer(&offset, self.sink));
        object.finish(self.sink);

        Some(AddressSource::HasOne { account: account?, owner: owner?, offset: offset? })
    }

    /// A reference to an address, or a literal address, which goes in the addresses table.
    pub(super) fn read_value(&mut self, node: &Node<'_>, visible: usize, table: Table) -> Option<ValueRef> {
        let text = node.str(self.sink)?;

        match reported(parse_value(text), node, self.sink)? {
            ValueText::Literal(literal) => {
                let bytes = reported(address(&literal), node, self.sink)?;

                Some(ValueRef { source: ValueSource::Address, index: self.addresses.index(bytes.into()) })
            }
            ValueText::Reference(reference) => self.resolve_address(reference, node, visible, table),
        }
    }

    fn resolve_address(
        &mut self,
        reference: Reference<'_>,
        node: &Node<'_>,
        visible: usize,
        table: Table,
    ) -> Option<ValueRef> {
        if reference.scope == Scope::Payers && table == Table::Builder {
            self.sink.push(
                Diagnostic::new(Code::BuilderAccountPayer, &node.pointer, "a builder account cannot be a payer")
                    .help("the builder names a payer in its instructions with `Payer::Fee` or `Payer::Rent`"),
            );

            return None;
        }

        let names = Names::new(
            self.schema,
            self.account_names.get(..visible).unwrap_or_default(),
            Allowed { payers: true, accounts: true },
        );
        let resolved = names.resolve(reference, &node.pointer, self.sink)?;

        if !matches!(resolved.shape.value_type.base, BaseType::Address | BaseType::Mint)
            || resolved.shape.value_type.array
        {
            self.sink.push(Diagnostic::new(
                Code::InvalidValue,
                &node.pointer,
                format!("`{{{}.{}}}` is not an address", reference.scope.as_str(), reference.name),
            ));

            return None;
        }

        ValueRef::try_from(resolved.value).ok()
    }

    pub(super) fn read_account_index(&mut self, node: &Node<'_>, visible: usize) -> Option<u8> {
        let text = node.str(self.sink)?;

        let reference = match reported(parse_value(text), node, self.sink)? {
            ValueText::Reference(reference) if reference.scope == Scope::Accounts => reference,
            _ => {
                self.sink.push(
                    Diagnostic::new(Code::InvalidValue, &node.pointer, "this must name an account")
                        .help("name an earlier account, such as `{accounts.vault}`"),
                );
                return None;
            }
        };

        let names = Names::new(
            self.schema,
            self.account_names.get(..visible).unwrap_or_default(),
            Allowed { payers: false, accounts: true },
        );

        names.resolve(reference, &node.pointer, self.sink).map(|resolved| resolved.value.index)
    }

    pub(super) fn read_literal_address(&mut self, node: &Node<'_>) -> Option<u8> {
        let text = node.str(self.sink)?;
        let bytes = reported(address(text), node, self.sink)?;

        Some(self.addresses.index(bytes.into()))
    }
}

/// Reads an integer that JSON writes as a string, such as `"44"`.
pub(super) fn read_integer<T: TryFrom<u64>>(node: &Node<'_>, sink: &mut Sink) -> Option<T> {
    if node.value.is_number() {
        sink.push(
            Diagnostic::new(Code::WrongType, &node.pointer, "write integers as strings")
                .help(format!("write \"{}\"", node.value)),
        );
        return None;
    }

    let text = node.str(sink)?;
    let value = text.parse::<u64>().ok().and_then(|value| T::try_from(value).ok());

    if value.is_none() {
        sink.push(Diagnostic::new(
            Code::InvalidValue,
            &node.pointer,
            format!("`{text}` is not an integer that fits here"),
        ));
    }

    value
}
