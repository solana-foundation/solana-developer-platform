//! The recipe: a static list of instructions, a builder call, a remote endpoint, or a shielded spend.

use sdp_intents_spec::wire::{AccountV1, InstructionV1, OutputBindingV1, RangeV1, SegmentV1};
use sdp_intents_spec::{AddressSource, RecipeKind};

use super::accounts::Table;
use super::Build;
use crate::diagnostic::{Code, Diagnostic};
use crate::reader::{list, Node, Object};
use crate::suggest::closest;

const KINDS: [&str; 4] = ["static", "program", "remote", "shielded"];

pub(super) struct Recipe {
    pub(super) kind: RecipeKind,
    pub(super) url: Vec<u8>,
}

impl Build<'_, '_> {
    pub(super) fn read_recipe(&mut self, node: &Node<'_>) -> Option<Recipe> {
        let mut object = node.object(self.sink)?;
        let kind_node = object.required("kind", self.sink)?;
        let kind = kind_node.str(self.sink)?;

        let recipe = match kind {
            "static" => self.read_static(&mut object),
            "program" => self.read_program(&mut object),
            "remote" => self.read_remote(&mut object),
            "shielded" => self.read_shielded(&mut object),
            _ => {
                let diagnostic =
                    Diagnostic::new(Code::InvalidValue, &kind_node.pointer, format!("`{kind}` is not a recipe kind"));

                self.sink.push(match closest(kind, KINDS.into_iter()) {
                    Some(known) => diagnostic.help(format!("did you mean `{known}`?")),
                    None => diagnostic.help(format!("the kinds are {}", list(&KINDS))),
                });
                None
            }
        };
        object.finish(self.sink);

        recipe
    }

    fn read_static(&mut self, object: &mut Object<'_>) -> Option<Recipe> {
        if let Some(accounts) = object.required("accounts", self.sink) {
            self.read_accounts(&accounts, Table::Static);
        }

        let instructions =
            object.required("instructions", self.sink).and_then(|instructions| instructions.array(self.sink));
        instructions?.iter().for_each(|instruction| self.read_instruction(instruction));

        if let Some(outputs) = object.field("outputs") {
            self.read_output_bindings(&outputs);
        }

        Some(Recipe { kind: RecipeKind::Static, url: Vec::new() })
    }

    /// `{ "url": "…", "returns": "instructions" | "transaction", "accounts": { … }, "outputs": { … } }`.
    /// The accounts and the output bindings are optional. They pin what the endpoint must not choose,
    /// such as the share mint or a provider's receiving wallet.
    fn read_remote(&mut self, object: &mut Object<'_>) -> Option<Recipe> {
        let url =
            object.required("url", self.sink).and_then(|url| url.str(self.sink).map(|url| url.as_bytes().to_vec()));
        let returns = object.required("returns", self.sink).and_then(|returns| match returns.str(self.sink)? {
            "instructions" => Some(RecipeKind::Remote),
            "transaction" => Some(RecipeKind::RemoteTransaction),
            other => {
                self.sink.push(
                    Diagnostic::new(
                        Code::InvalidValue,
                        &returns.pointer,
                        format!("`{other}` is not what an endpoint returns"),
                    )
                    .help("an endpoint returns `instructions` or `transaction`"),
                );
                None
            }
        });

        if let Some(accounts) = object.field("accounts") {
            self.read_accounts(&accounts, Table::Static);
        }

        if let Some(outputs) = object.field("outputs") {
            self.read_output_bindings(&outputs);
        }

        Some(Recipe { kind: returns?, url: url? })
    }

    /// `{ "pool": "…", "accounts": [ … ], "notes": [ … ] }`. The first account is the spender, whose
    /// notes the spend consumes. Each note is stored as an instruction of the pool, so the account
    /// sources and segments of a static recipe apply to it.
    fn read_shielded(&mut self, object: &mut Object<'_>) -> Option<Recipe> {
        let pool = object.required("pool", self.sink).and_then(|pool| self.read_literal_address(&pool));

        if let Some(accounts) = object.required("accounts", self.sink) {
            self.read_accounts(&accounts, Table::Static);
        }

        if self.account_names.first().map(String::as_str) != Some("spender") {
            self.sink.push(
                Diagnostic::new(
                    Code::MissingKey,
                    &format!("{}/accounts/0", object.pointer()),
                    "the first account is not `spender`",
                )
                .help("name the account whose notes the spend consumes `spender`, and list it first"),
            );
        }

        let pool = self.program_account(pool?, "pool");
        let notes = object.required("notes", self.sink).and_then(|notes| notes.array(self.sink));
        notes?.iter().for_each(|note| self.read_note(note, pool));

        Some(Recipe { kind: RecipeKind::Shielded, url: Vec::new() })
    }

    /// `{ "owner": "recipient", "asset": { … }, "amount": { … }, "data": [ … ] }`. The asset is an
    /// `address` segment and the amount a `u64le` segment.
    fn read_note(&mut self, node: &Node<'_>, pool: u8) {
        let Some(mut object) = node.object(self.sink) else {
            return;
        };
        let owner = object.required("owner", self.sink).and_then(|owner| self.account_by_name(&owner));
        let asset = object.required("asset", self.sink);
        let amount = object.required("amount", self.sink);
        let data = object.field("data").and_then(|data| data.array(self.sink)).unwrap_or_default();
        object.finish(self.sink);

        let visible = self.accounts.len();
        let nodes: Vec<Option<Node<'_>>> = [asset, amount].into_iter().chain(data.into_iter().map(Some)).collect();
        let segments: Option<Vec<SegmentV1>> = nodes
            .iter()
            .map(|segment| segment.as_ref().and_then(|segment| self.read_segment(segment, visible, false)))
            .collect();

        let (Some(owner), Some(segments)) = (owner, segments) else {
            return;
        };

        let first_account = self.instruction_accounts.len();
        self.instruction_accounts.push(owner);

        if let (Some(accounts), Some(segments)) =
            (range(first_account, self.instruction_accounts.len()), self.push_segments(segments))
        {
            self.instructions.push(InstructionV1 { program: pool, accounts, segments });
        }
    }

    /// The builder call is one instruction, which passes every implementation account, in order, to the
    /// builder program.
    fn read_program(&mut self, object: &mut Object<'_>) -> Option<Recipe> {
        let program = object.required("program", self.sink).and_then(|program| self.read_literal_address(&program));

        if let Some(accounts) = object.required("accounts", self.sink) {
            self.read_accounts(&accounts, Table::Builder);
        }

        let account_count = self.accounts.len();
        let data = object.required("data", self.sink).and_then(|data| data.array(self.sink));
        let segments: Vec<SegmentV1> =
            data?.iter().filter_map(|segment| self.read_segment(segment, account_count, true)).collect();

        let first_account = self.instruction_accounts.len();
        let indexes: Vec<u8> = (0..account_count).filter_map(|index| u8::try_from(index).ok()).collect();
        self.instruction_accounts.extend(indexes);

        let program = self.program_account(program?, "program");
        let instruction = InstructionV1 {
            program,
            accounts: range(first_account, self.instruction_accounts.len())?,
            segments: self.push_segments(segments)?,
        };
        self.instructions.push(instruction);

        Some(Recipe { kind: RecipeKind::Program, url: Vec::new() })
    }

    /// `{ "program": "…", "accounts": ["source", …], "data": [ … ] }`.
    fn read_instruction(&mut self, node: &Node<'_>) {
        let Some(mut object) = node.object(self.sink) else {
            return;
        };
        let program = object.required("program", self.sink).and_then(|program| {
            let text = program.str(self.sink)?.to_owned();

            self.read_literal_address(&program).map(|address| self.program_account(address, &text))
        });
        let accounts = object.required("accounts", self.sink).and_then(|accounts| accounts.array(self.sink));
        let data = object.required("data", self.sink).and_then(|data| data.array(self.sink));
        object.finish(self.sink);

        let indexes: Vec<Option<u8>> =
            accounts.unwrap_or_default().iter().map(|account| self.account_by_name(account)).collect();
        let all_accounts = self.accounts.len();
        let segments: Vec<SegmentV1> = data
            .unwrap_or_default()
            .iter()
            .filter_map(|segment| self.read_segment(segment, all_accounts, false))
            .collect();

        let (Some(program), Some(indexes)) = (program, indexes.into_iter().collect::<Option<Vec<u8>>>()) else {
            return;
        };

        let first_account = self.instruction_accounts.len();
        self.instruction_accounts.extend(indexes);

        if let (Some(accounts), Some(segments)) =
            (range(first_account, self.instruction_accounts.len()), self.push_segments(segments))
        {
            self.instructions.push(InstructionV1 { program, accounts, segments });
        }
    }

    fn account_by_name(&mut self, node: &Node<'_>) -> Option<u8> {
        let name = node.str(self.sink)?;
        let index = self.account_names.iter().position(|known| known == name);

        if index.is_none() {
            let diagnostic =
                Diagnostic::new(Code::UnknownReference, &node.pointer, format!("no account is named `{name}`"));
            let help = match closest(name, self.account_names.iter().map(String::as_str)) {
                Some(known) => format!("did you mean `{known}`?"),
                None => format!("the accounts are {}", list(&self.account_names)),
            };

            self.sink.push(diagnostic.help(help));
        }

        index.and_then(|index| u8::try_from(index).ok())
    }

    /// The account of a program. A static account with the same address is used when there is one.
    fn program_account(&mut self, address: u8, name: &str) -> u8 {
        let existing =
            self.accounts.iter().position(|account| account.address() == Ok(AddressSource::Static { address }));

        let index = existing.unwrap_or_else(|| {
            let account =
                AccountV1::new(self.pool.add(name.as_bytes()), false, false, AddressSource::Static { address });
            self.push_account(name.to_owned(), account);

            self.accounts.len().saturating_sub(1)
        });

        u8::try_from(index).unwrap_or(u8::MAX)
    }

    fn push_segments(&mut self, segments: Vec<SegmentV1>) -> Option<RangeV1> {
        let first = self.segments.len();
        self.segments.extend(segments);

        range(first, self.segments.len())
    }

    /// `{ "shareMint": "shareMint" }`: each output comes from an account of the table.
    fn read_output_bindings(&mut self, node: &Node<'_>) {
        let Some(map) = node.value.as_object() else {
            self.sink.push(Diagnostic::new(
                Code::WrongType,
                &node.pointer,
                "expected an object of output names to account names",
            ));
            return;
        };

        let bindings: Vec<OutputBindingV1> = map
            .iter()
            .filter_map(|(output, account)| {
                let pointer = format!("{}/{}", node.pointer, crate::spans::escape_pointer(output));
                let output_index = self.schema.outputs.iter().position(|field| field.name == *output);
                let account_index =
                    account.as_str().and_then(|name| self.account_names.iter().position(|known| known == name));

                if output_index.is_none() {
                    self.sink.push(
                        Diagnostic::new(
                            Code::UnknownReference,
                            &pointer,
                            format!("the interface has no output `{output}`"),
                        )
                        .at_key(),
                    );
                }

                if account_index.is_none() {
                    self.sink.push(Diagnostic::new(
                        Code::UnknownReference,
                        &pointer,
                        "this names no account of the table",
                    ));
                }

                Some(OutputBindingV1 {
                    output: u8::try_from(output_index?).ok()?,
                    account: u8::try_from(account_index?).ok()?,
                })
            })
            .collect();

        self.output_bindings.extend(bindings);
    }
}

fn range(first: usize, end: usize) -> Option<RangeV1> {
    Some(RangeV1 { first: u8::try_from(first).ok()?, count: u8::try_from(end.saturating_sub(first)).ok()? })
}
