//! Compiles an implementation against its interface.

mod accounts;
mod applies;
mod recipe;
mod segments;
mod write;

use sdp_intents_spec::wire::{
    AccountV1, AppliesV1, DocumentIdV1, InstructionV1, OutputBindingV1, PostConditionV1, SegmentV1, SemverV1,
};
use sdp_intents_spec::{Address, CheckKind, RecipeKind};
use serde_json::Value;

use crate::catalog::Catalog;
use crate::diagnostic::{Code, Diagnostic, Report};
use crate::encoding::address;
use crate::envelope::{parse_json, read_envelope, reported, root};
use crate::id::Id;
use crate::limits;
use crate::post_condition::{read_post_condition, Output};
use crate::reader::{Node, Object, Sink};
use crate::resolve::read_implements;
use crate::scope::{Allowed, Names, Schema};
use crate::template::compile_template;
use crate::writer::{AddressTable, Pool};

/// An implementation in binary form, with the parts of it that an intent names.
#[derive(Clone, Debug)]
pub struct CompiledImplementation {
    pub id: Id,
    pub version: SemverV1,
    pub document_id: DocumentIdV1,
    /// The interface, at the lowest version that the implementation implements.
    pub implements: DocumentIdV1,
    pub bytes: Vec<u8>,
}

pub(crate) fn compile_implementation(text: &str, catalog: &Catalog) -> Result<CompiledImplementation, Report> {
    let value = parse_json(text)?;
    let mut sink = Sink::default();
    let compiled = compile(&value, catalog, &mut sink);

    match compiled {
        Some(compiled) if sink.is_empty() => Ok(compiled),
        _ => Err(Report { diagnostics: sink.into_diagnostics(), syntax: None }),
    }
}

/// The tables of one implementation, as the compile adds to them. The steps are methods in the files of
/// this module.
struct Build<'c, 's> {
    schema: &'c Schema,
    sink: &'s mut Sink,
    pool: Pool,
    addresses: AddressTable,
    accounts: Vec<AccountV1>,
    account_names: Vec<String>,
    seeds: Vec<SegmentV1>,
    segments: Vec<SegmentV1>,
    instructions: Vec<InstructionV1>,
    instruction_accounts: Vec<u8>,
    applies: Vec<AppliesV1>,
    post_conditions: Vec<PostConditionV1>,
    output_bindings: Vec<OutputBindingV1>,
}

/// A cluster's name, such as `mainnet`, or its genesis hash.
pub(crate) fn read_cluster(node: &Node<'_>, sink: &mut Sink) -> Option<Address> {
    let text = node.str(sink)?;

    match sdp_intents_spec::cluster::genesis_hash(text) {
        Some(hash) => Some(hash),
        None => reported(address(text), node, sink).map(Address),
    }
}

fn compile(value: &Value, catalog: &Catalog, sink: &mut Sink) -> Option<CompiledImplementation> {
    let mut object = root(value, sink)?;
    let envelope = read_envelope(&mut object, "implementation", catalog, sink);

    let cluster = object.required("cluster", sink).and_then(|cluster| read_cluster(&cluster, sink));

    let implements = object.required("implements", sink).and_then(|node| read_implements(&node, catalog, sink))?;
    let mut build = Build::new(&implements.interface.schema, sink);

    if let Some(applies) = object.field("applies") {
        build.read_applies(&applies);
    }

    let message = object.required("message", build.sink).and_then(|message| {
        let names = Names::new(build.schema, &[], Allowed { payers: false, accounts: false, builder: false });

        compile_template(&message, &names, build.sink)
    });
    let recipe = object.required("recipe", build.sink).and_then(|recipe| build.read_recipe(&recipe));
    build.read_post_conditions(&mut object);

    let pointer = object.pointer().to_owned();
    let remote =
        recipe.as_ref().is_some_and(|recipe| matches!(recipe.kind, RecipeKind::Remote | RecipeKind::RemoteTransaction));
    let invokes_only =
        build.post_conditions.iter().any(|condition| condition.check == u8::from(CheckKind::InvokesOnly));

    if remote && !invokes_only {
        build.sink.push(
            Diagnostic::new(Code::MissingKey, &pointer, "a remote recipe needs an `invokesOnly` postcondition")
                .help("list every program that the endpoint's instructions can call"),
        );
    }

    object.finish(build.sink);
    build.check_limits(&pointer);

    let envelope = envelope?;
    let message = message?;
    let recipe = recipe?;
    let cluster = cluster?;

    if !build.sink.is_empty() {
        return None;
    }

    let bytes = build.write(&envelope, &implements, &message, recipe, cluster)?;

    Some(CompiledImplementation {
        id: envelope.id,
        version: envelope.version,
        document_id: envelope.document_id,
        implements: DocumentIdV1 { version: implements.lowest, ..implements.interface.document_id },
        bytes,
    })
}

impl<'c, 's> Build<'c, 's> {
    fn new(schema: &'c Schema, sink: &'s mut Sink) -> Self {
        Self {
            schema,
            sink,
            pool: Pool::default(),
            addresses: AddressTable::default(),
            accounts: Vec::new(),
            account_names: Vec::new(),
            seeds: Vec::new(),
            segments: Vec::new(),
            instructions: Vec::new(),
            instruction_accounts: Vec::new(),
            applies: Vec::new(),
            post_conditions: Vec::new(),
            output_bindings: Vec::new(),
        }
    }

    fn read_post_conditions(&mut self, object: &mut Object<'_>) {
        let Some(nodes) = object.field("postConditions").and_then(|conditions| conditions.array(self.sink)) else {
            return;
        };
        // An implementation's postcondition can name its accounts, such as a provider's receiving wallet
        // that the implementation pins (`DESIGN.md`, 4.15).
        let account_names = self.account_names.clone();
        let names = Names::new(self.schema, &account_names, Allowed { payers: false, accounts: true, builder: false });

        let conditions: Vec<PostConditionV1> = nodes
            .iter()
            .filter_map(|condition| {
                let output = Output { pool: &mut self.pool, addresses: &mut self.addresses };

                read_post_condition(condition, &names, true, output, self.sink)
            })
            .collect();

        self.post_conditions.extend(conditions);
    }

    fn check_limits(&mut self, pointer: &str) {
        let counts = [
            ("applies checks", self.applies.len(), limits::APPLIES),
            ("post conditions", self.post_conditions.len(), limits::POST_CONDITIONS),
            ("addresses", self.addresses.as_slice().len(), limits::ADDRESSES),
            ("accounts", self.accounts.len(), limits::ACCOUNTS),
            ("seeds", self.seeds.len(), limits::SEEDS),
            ("instructions", self.instructions.len(), limits::INSTRUCTIONS),
            ("segments", self.segments.len(), limits::SEGMENTS),
        ];

        counts.into_iter().for_each(|(what, count, limit)| limits::check(self.sink, pointer, what, count, limit));
    }
}

#[cfg(test)]
mod tests {
    use sdp_intents_spec::{AddressSource, Encoding, Implementation, RecipeKind, Segment, ValueRef, ValueSource};

    use super::compile_implementation;
    use crate::diagnostic::Code;
    use crate::test_support::{catalog, edit, publishers, SPL_TOKEN_TRANSFER, SYSTEM_TRANSFER, TOKEN_2022_TRANSFER};

    #[test]
    fn compiles_the_system_transfer() {
        let compiled = compile_implementation(SYSTEM_TRANSFER, &catalog()).unwrap();
        let implementation = Implementation::parse(&compiled.bytes).unwrap();
        let instruction = implementation.instructions().unwrap().first().unwrap();

        assert_eq!(implementation.recipe(), Ok(RecipeKind::Static));
        assert_eq!(implementation.applies().unwrap().len(), 2);
        assert_eq!(implementation.accounts().unwrap().len(), 3);
        assert_eq!(implementation.instruction_accounts(instruction).unwrap(), &[0, 1]);
        assert_eq!(implementation.message().unwrap(), b"transfer {i3} SOL from {i0} to {i1}");
    }

    /// A remote transfer with a pinned account, which the interface has no output to bind.
    const REMOTE_TRANSFER: &str = r#"{
      "spec": "sdp-intents@1.0", "kind": "implementation", "id": "solana.org/remote-transfer", "version": "1.0.0",
      "cluster": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "implements": "solana.org/token.transfer@^1",
      "message": "transfer {inputs.amount} of {inputs.mint}",
      "recipe": { "kind": "remote", "url": "https://example.invalid", "returns": "instructions",
                  "accounts": [{ "name": "wallet", "address": "11111111111111111111111111111112" }] },
      "postConditions": [{ "invokesOnly": ["11111111111111111111111111111111"], "message": "only System instructions run" }]
    }"#;

    #[test]
    fn compiles_a_remote_recipe_with_pinned_accounts() {
        let compiled = compile_implementation(REMOTE_TRANSFER, &catalog()).unwrap();
        let implementation = Implementation::parse(&compiled.bytes).unwrap();

        assert_eq!(implementation.recipe(), Ok(RecipeKind::Remote));
        assert_eq!(implementation.url().unwrap(), b"https://example.invalid");
        assert_eq!(implementation.accounts().unwrap().len(), 1);
    }

    #[test]
    fn a_remote_recipe_states_invokes_only_and_what_it_returns() {
        let no_invokes_only = REMOTE_TRANSFER.replace(
            r#""invokesOnly": ["11111111111111111111111111111111"]"#,
            r#""outflow": { "from": "{inputs.from}", "mint": "{inputs.mint}", "max": "{inputs.amount}" }"#,
        );
        let unknown_returns = REMOTE_TRANSFER.replace(r#""returns": "instructions""#, r#""returns": "quotes""#);
        let codes = |text: &str| compile_implementation(text, &catalog()).err().map(|report| report.codes());

        assert_eq!(codes(&no_invokes_only), Some(vec![Code::MissingKey]));
        assert_eq!(codes(&unknown_returns), Some(vec![Code::InvalidValue]));
        assert_eq!(
            compile_implementation(
                &REMOTE_TRANSFER.replace(r#""returns": "instructions""#, r#""returns": "transaction""#),
                &catalog()
            )
            .map(|compiled| Implementation::parse(&compiled.bytes)
                .and_then(|implementation| implementation.recipe())
                .ok()),
            Ok(Some(RecipeKind::RemoteTransaction))
        );
    }

    #[test]
    fn compiles_the_spl_token_transfer() {
        let compiled = compile_implementation(SPL_TOKEN_TRANSFER, &catalog()).unwrap();
        let implementation = Implementation::parse(&compiled.bytes).unwrap();
        let instructions = implementation.instructions().unwrap();
        let transfer_data = implementation.instruction_segments(instructions.get(1).unwrap()).unwrap();

        assert_eq!(instructions.len(), 2);
        assert!(matches!(implementation.accounts().unwrap().get(6).unwrap().address(), Ok(AddressSource::Ata { .. })));
        assert_eq!(
            transfer_data.get(2).unwrap().decode(),
            Ok(Segment::AccountBytes { account: 3, owner: 0, offset: 44, length: 1 })
        );
    }

    #[test]
    fn compiles_the_token_2022_builder_call() {
        let compiled = compile_implementation(TOKEN_2022_TRANSFER, &catalog()).unwrap();
        let implementation = Implementation::parse(&compiled.bytes).unwrap();
        let call = implementation.instructions().unwrap().first().unwrap();

        assert_eq!(implementation.recipe(), Ok(RecipeKind::Program));
        assert_eq!(implementation.instruction_accounts(call).unwrap(), &[0, 1, 2, 3, 4]);
        assert_eq!(implementation.instruction_segments(call).unwrap().len(), 4);
        assert_eq!(implementation.post_conditions().unwrap().len(), 1);
    }

    /// A builder call can pass the builder's bumps, in borsh. No other place can name them.
    #[test]
    fn only_a_builder_call_names_the_bumps() {
        let compiled = compile_implementation(TOKEN_2022_TRANSFER, &catalog()).unwrap();
        let implementation = Implementation::parse(&compiled.bytes).unwrap();
        let call = implementation.instructions().unwrap().first().unwrap();
        let last = implementation.instruction_segments(call).unwrap().last().unwrap().decode().unwrap();
        let static_bumps = edit(
            SYSTEM_TRANSFER,
            r#"{ "value": "{inputs.amount}", "encoding": "u64le" }"#,
            r#"{ "value": "{inputs.amount}", "encoding": "u64le" }, { "value": "{builder.bumps}", "encoding": "borsh" }"#,
        );

        assert_eq!(
            last,
            Segment::Reference { value: ValueRef { source: ValueSource::Bumps, index: 0 }, encoding: Encoding::Borsh }
        );
        assert_eq!(compile_implementation(&static_bumps, &catalog()).unwrap_err().codes(), [Code::ReferenceNotAllowed]);
    }

    #[test]
    fn names_the_input_that_a_typo_meant() {
        let text = edit(SYSTEM_TRANSFER, r#""{inputs.amount}", "encoding""#, r#""{inputs.amout}", "encoding""#);
        let report = compile_implementation(&text, &catalog()).unwrap_err();
        let rendered = report.render("system-transfer/1.0.0.json", &text);

        assert_eq!(report.codes(), [Code::UnknownReference]);
        assert!(rendered.contains("--> system-transfer/1.0.0.json:25:22"), "{rendered}");
        assert!(rendered.contains("did you mean `{inputs.amount}`?"), "{rendered}");
    }

    #[test]
    fn names_the_encoding_that_fits() {
        let text = edit(SYSTEM_TRANSFER, r#""encoding": "u64le""#, r#""encoding": "u32le""#);
        let report = compile_implementation(&text, &catalog()).unwrap_err();
        let diagnostic = report.diagnostics.first().unwrap();

        assert_eq!(diagnostic.code, Code::EncodingMismatch);
        assert_eq!(diagnostic.pointer, "/recipe/instructions/0/data/1/encoding");
        assert_eq!(diagnostic.help.as_deref(), Some("use `u64le`"));
    }

    #[test]
    fn a_builder_account_is_readonly_and_never_a_payer() {
        let writable = edit(
            TOKEN_2022_TRANSFER,
            r#"{ "name": "mint", "address": "{inputs.mint}" }"#,
            r#"{ "name": "mint", "address": "{inputs.mint}", "writable": true }"#,
        );
        let payer = edit(TOKEN_2022_TRANSFER, r#""address": "{inputs.to}""#, r#""address": "{payers.rent}""#);

        assert_eq!(compile_implementation(&writable, &catalog()).unwrap_err().codes(), [Code::BuilderAccountWritable]);
        assert_eq!(compile_implementation(&payer, &catalog()).unwrap_err().codes(), [Code::BuilderAccountPayer]);
    }

    #[test]
    fn reports_every_finding_in_one_pass() {
        let text = edit(
            SPL_TOKEN_TRANSFER,
            r#""accounts": ["source", "mint", "destination", "from"]"#,
            r#""accounts": ["sorce", "mint", "destination", "from"]"#,
        );
        let text = edit(&text, r#""message":"#, r#""mesage":"#);
        let report = compile_implementation(&text, &catalog()).unwrap_err();

        assert!(report.codes().contains(&Code::UnknownReference));
        assert!(report.codes().contains(&Code::UnknownKey));
        assert!(report.codes().contains(&Code::MissingKey));
    }

    #[test]
    fn names_the_interfaces_that_exist() {
        let text = edit(SYSTEM_TRANSFER, "solana.org/token.transfer@^1", "solana.org/token.send@^1");
        let report = compile_implementation(&text, &catalog()).unwrap_err();

        assert_eq!(report.codes(), [Code::UnknownInterface]);
        assert_eq!(
            report.diagnostics.first().unwrap().help.as_deref(),
            Some("the defined interfaces are `solana.org/token.transfer`")
        );
    }

    #[test]
    fn an_interface_that_failed_is_not_unknown() {
        let mut catalog = publishers();
        catalog.add_failed_interface("solana.org/token.transfer");

        let report = compile_implementation(SYSTEM_TRANSFER, &catalog).unwrap_err();

        assert_eq!(report.codes(), [Code::InterfaceFailed]);
    }

    #[test]
    fn a_syntax_error_keeps_its_line() {
        let text = edit(SYSTEM_TRANSFER, r#""version": "1.0.0","#, r#""version": "1.0.0""#);
        let report = compile_implementation(&text, &catalog()).unwrap_err();

        assert_eq!(report.syntax.as_ref().map(|syntax| syntax.line), Some(6));
    }
}
