//! The recipe: a static list of instructions, a builder call, a remote endpoint, or a shielded spend.

use sdp_intents_spec::wire::{DocumentRefV1, InstructionV1};
use sdp_intents_spec::{AddressSource, RecipeKind, ShieldedEntry, ShieldedProtocol, SpecError};
use serde_json::{Map, Value};

use super::implementation::Document;
use super::json::{non_empty, object, sparse_object, utf8, LiteralPlace};
use super::programs::ProgramName;
use super::{document_name, DecompileError};
use crate::id::format_version;

impl Document<'_, '_> {
    pub(super) fn recipe(&self) -> Result<Value, DecompileError> {
        match self.view.recipe()? {
            RecipeKind::Static => self.static_recipe(),
            RecipeKind::Program => self.program_recipe(),
            RecipeKind::Remote => self.remote_recipe("instructions"),
            RecipeKind::RemoteTransaction => self.remote_recipe("transaction"),
            RecipeKind::Shielded => self.shielded_recipe(),
            RecipeKind::Flow => self.flow_recipe(),
        }
    }

    fn static_recipe(&self) -> Result<Value, DecompileError> {
        let declared = self.declared_accounts()?;
        let instructions: Vec<Value> = self
            .view
            .instructions()?
            .iter()
            .map(|instruction| self.instruction(instruction))
            .collect::<Result<_, _>>()?;

        Ok(sparse_object([
            ("kind", Some(Value::from("static"))),
            ("accounts", Some(Value::Array(self.accounts(declared)?))),
            ("instructions", Some(Value::Array(instructions))),
            ("outputs", self.output_bindings()?),
        ]))
    }

    /// The builder call passes every account that the JSON states, in order. The compiler adds the
    /// builder program's account after them when no account holds it.
    fn program_recipe(&self) -> Result<Value, DecompileError> {
        let [call] = self.view.instructions()? else {
            return Err(SpecError::BadRecipe.into());
        };

        let passed = self.view.instruction_accounts(call)?;
        let declared = passed.len();
        let in_order = passed.iter().enumerate().all(|(position, account)| usize::from(*account) == position);

        if !in_order || !self.reproduces(declared, ProgramName::Builder)? {
            return Err(DecompileError::Unrepresentable("a builder call that does not pass every account in order"));
        }

        if !self.view.output_bindings()?.is_empty() {
            return Err(DecompileError::Unrepresentable("output bindings in a program recipe"));
        }

        Ok(object([
            ("kind", Value::from("program")),
            ("program", Value::from(self.program(call)?)),
            ("accounts", Value::Array(self.accounts(declared)?)),
            ("data", Value::Array(self.segments(call)?)),
        ]))
    }

    /// The pool account is the one that the compiler adds after the stated accounts, unless a stated
    /// account holds the pool's address. Each instruction is a note, a deposit, or a withdrawal: its
    /// one account is the owner or the public account, and its segments are the asset, the amount,
    /// and a note's data.
    fn shielded_recipe(&self) -> Result<Value, DecompileError> {
        let declared = (0..=self.view.accounts()?.len())
            .find_map(|declared| {
                self.reproduces(declared, ProgramName::Pool).map(|ok| ok.then_some(declared)).transpose()
            })
            .unwrap_or(Err(DecompileError::Unrepresentable("a pool that is not the first account with its address")))?;
        let instructions = self.view.instructions()?;
        let pool = instructions.first().ok_or(SpecError::BadRecipe)?;
        let doc = self.view.shielded()?.ok_or(SpecError::BadRecipe)?;
        let entries = instructions
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                Ok((self.view.shielded_entry(index)?.ok_or(SpecError::BadRecipe)?, self.shielded_entry(entry)?))
            })
            .collect::<Result<Vec<_>, DecompileError>>()?;
        let list = |wanted: ShieldedEntry, account: &str| -> Vec<Value> {
            entries
                .iter()
                .filter(|(entry, _)| *entry == wanted)
                .map(|(_, fields)| fields.with_account(account))
                .collect()
        };

        let protocol = match ShieldedProtocol::try_from(doc.protocol)? {
            ShieldedProtocol::PrivacyRings => "privacy-rings",
        };

        Ok(sparse_object([
            ("kind", Some(Value::from("shielded"))),
            ("protocol", Some(Value::from(protocol))),
            ("pool", Some(Value::from(self.program(pool)?))),
            ("circuit", Some(Value::from(self.circuit(&doc.circuit)?))),
            ("accounts", Some(Value::Array(self.accounts(declared)?))),
            ("notes", Some(Value::Array(list(ShieldedEntry::Note, "owner")))),
            ("deposits", non_empty(list(ShieldedEntry::Deposit, "from"))),
            ("withdrawals", non_empty(list(ShieldedEntry::Withdrawal, "to"))),
        ]))
    }

    /// `solana.org/privacy-rings-transact@1.0.0`.
    fn circuit(&self, circuit: &DocumentRefV1) -> Result<String, DecompileError> {
        let id = document_name(&circuit.id, self.view.text(circuit.name)?, self.organizations)?;

        Ok(format!("{id}@{}", format_version(circuit.id.version)))
    }

    fn shielded_entry(&self, entry: &InstructionV1) -> Result<EntryFields, DecompileError> {
        let [account] = self.view.instruction_accounts(entry)? else {
            return Err(SpecError::BadRecipe.into());
        };
        let mut segments = self.segments(entry)?.into_iter();
        let (Some(asset), Some(amount)) = (segments.next(), segments.next()) else {
            return Err(SpecError::BadRecipe.into());
        };

        Ok(EntryFields { account: self.names.account(*account)?.to_owned(), asset, amount, data: segments.collect() })
    }

    fn remote_recipe(&self, returns: &str) -> Result<Value, DecompileError> {
        let accounts = self.accounts(self.view.accounts()?.len())?;

        Ok(sparse_object([
            ("kind", Some(Value::from("remote"))),
            ("url", Some(Value::from(utf8(self.view.url()?)?))),
            ("returns", Some(Value::from(returns))),
            ("accounts", non_empty(accounts)),
            ("outputs", self.output_bindings()?),
        ]))
    }

    fn instruction(&self, instruction: &InstructionV1) -> Result<Value, DecompileError> {
        let accounts: Vec<Value> = self
            .view
            .instruction_accounts(instruction)?
            .iter()
            .map(|account| self.names.account(*account).map(Value::from))
            .collect::<Result<_, _>>()?;

        Ok(object([
            ("program", Value::from(self.program(instruction)?)),
            ("accounts", Value::Array(accounts)),
            ("data", Value::Array(self.segments(instruction)?)),
        ]))
    }

    fn segments(&self, instruction: &InstructionV1) -> Result<Vec<Value>, DecompileError> {
        self.view
            .instruction_segments(instruction)?
            .iter()
            .map(|segment| self.segment(segment, LiteralPlace::Data))
            .collect()
    }

    /// JSON names an instruction's program by its address.
    fn program(&self, instruction: &InstructionV1) -> Result<String, DecompileError> {
        let account = self.view.accounts()?.get(usize::from(instruction.program)).ok_or(SpecError::BadIndex)?;

        match account.address()? {
            AddressSource::Static { address } => self.names.address(address),
            _ => Err(DecompileError::Unrepresentable("an instruction program that is not a static address")),
        }
    }

    /// `{ "shareMint": "shareMint" }`, or `None` when the recipe binds no output.
    fn output_bindings(&self) -> Result<Option<Value>, DecompileError> {
        let entries = self.view.output_bindings()?;
        let bindings: Map<String, Value> = entries
            .iter()
            .map(|binding| {
                let output = self.names.output(binding.output)?.to_owned();

                Ok((output, Value::from(self.names.account(binding.account)?)))
            })
            .collect::<Result<_, DecompileError>>()?;

        if bindings.len() != entries.len() {
            return Err(DecompileError::Unrepresentable("two bindings of one output"));
        }

        Ok((!bindings.is_empty()).then_some(Value::Object(bindings)))
    }
}

/// The fields of a shielded entry, before its account key is known.
struct EntryFields {
    account: String,
    asset: Value,
    amount: Value,
    data: Vec<Value>,
}

impl EntryFields {
    fn with_account(&self, key: &str) -> Value {
        sparse_object([
            (key, Some(Value::from(self.account.as_str()))),
            ("asset", Some(self.asset.clone())),
            ("amount", Some(self.amount.clone())),
            ("data", non_empty(self.data.clone())),
        ])
    }
}
