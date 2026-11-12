//! Compiles an implementation record against its interface.

mod accounts;
mod applies;
mod recipe;
mod segments;
mod write;

use sdp_intents_spec::{AccountV1, AppliesV1, InstructionV1, OutputBindingV1, PostConditionV1, SegmentV1, SemverV1};
use serde_json::Value;

use crate::catalog::Catalog;
use crate::diagnostic::{Code, Diagnostic, Report};
use crate::encoding::address;
use crate::envelope::{parse_json, read_envelope, reported, root};
use crate::id::{format_version, IdRange};
use crate::interface::CompiledInterface;
use crate::limits;
use crate::post_condition::{read_post_condition, Output};
use crate::reader::{list, Object, Sink};
use crate::scope::{Allowed, Names, Schema};
use crate::template::compile_template;
use crate::writer::{AddressTable, Pool};

pub fn compile_implementation(text: &str, catalog: &Catalog) -> Result<Vec<u8>, Report> {
    let value = parse_json(text)?;
    let mut sink = Sink::default();
    let bytes = compile(&value, catalog, &mut sink);

    match bytes {
        Some(bytes) if sink.is_empty() => Ok(bytes),
        _ => Err(Report { diagnostics: sink.into_diagnostics(), syntax: None }),
    }
}

/// The interface that a record implements, and the lowest version of it that the record names.
struct Implements<'c> {
    interface: &'c CompiledInterface,
    lowest: SemverV1,
}

/// The tables of one record, as the compile adds to them. The steps are methods in the files of
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

fn compile(value: &Value, catalog: &Catalog, sink: &mut Sink) -> Option<Vec<u8>> {
    let mut object = root(value, sink)?;
    let envelope = read_envelope(&mut object, "implementation", catalog, sink);

    if let Some(cluster) = object.required("cluster", sink) {
        cluster.str(sink).and_then(|text| reported(address(text), &cluster, sink));
    }

    let implements = read_implements(&mut object, catalog, sink)?;
    let mut build = Build::new(&implements.interface.schema, sink);

    if let Some(applies) = object.field("applies") {
        build.read_applies(&applies);
    }

    let message = object.required("message", build.sink).and_then(|message| {
        let names = Names::new(build.schema, &[], Allowed { payers: false, accounts: false });

        compile_template(&message, &names, build.sink)
    });
    let recipe = object.required("recipe", build.sink).and_then(|recipe| build.read_recipe(&recipe));
    build.read_post_conditions(&mut object);

    let pointer = object.pointer().to_owned();
    object.finish(build.sink);
    build.check_limits(&pointer);

    let envelope = envelope?;
    let message = message?;
    let recipe = recipe?;

    if !build.sink.is_empty() {
        return None;
    }

    build.write(&envelope, &implements, &message, recipe)
}

fn read_implements<'c>(object: &mut Object<'_>, catalog: &'c Catalog, sink: &mut Sink) -> Option<Implements<'c>> {
    let node = object.required("implements", sink)?;
    let range = reported(IdRange::parse(node.str(sink)?), &node, sink)?;
    let id = range.id.to_string();

    let Some(interface) = catalog.interface(&id) else {
        sink.push(missing_interface(&id, &node.pointer, catalog));

        return None;
    };

    let defined = interface.version;
    let covered = range.lowest.major == defined.major
        && (range.lowest.minor.get(), range.lowest.patch.get()) <= (defined.minor.get(), defined.patch.get());

    if !covered {
        sink.push(
            Diagnostic::new(
                Code::VersionMismatch,
                &node.pointer,
                format!("`{id}` is at version {}, which this range does not cover", format_version(defined)),
            )
            .help(format!("use `{id}@^{}`", defined.major.get())),
        );

        return None;
    }

    Some(Implements { interface, lowest: range.lowest })
}

fn missing_interface(id: &str, pointer: &str, catalog: &Catalog) -> Diagnostic {
    if catalog.interface_failed(id) {
        return Diagnostic::new(Code::InterfaceFailed, pointer, format!("interface `{id}` did not compile"))
            .help(format!("fix the findings in `{id}` first"));
    }

    Diagnostic::new(Code::UnknownInterface, pointer, format!("no interface `{id}` is defined"))
        .help(format!("the defined interfaces are {}", list(&catalog.interface_ids())))
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
        let names = Names::new(self.schema, &[], Allowed { payers: false, accounts: false });

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
    use sdp_intents_spec::{AddressSource, Implementation, RecipeKind, Segment};

    use super::compile_implementation;
    use crate::test_support::{catalog, edit, publishers, SPL_TOKEN_TRANSFER, SYSTEM_TRANSFER, TOKEN_2022_TRANSFER};
    use crate::Code;

    #[test]
    fn compiles_the_system_transfer() {
        let bytes = compile_implementation(SYSTEM_TRANSFER, &catalog()).unwrap();
        let record = Implementation::parse(&bytes).unwrap();
        let instruction = record.instructions().unwrap().first().unwrap();

        assert_eq!(record.recipe(), Ok(RecipeKind::Static));
        assert_eq!(record.applies().unwrap().len(), 2);
        assert_eq!(record.accounts().unwrap().len(), 3);
        assert_eq!(record.instruction_accounts(instruction).unwrap(), &[0, 1]);
        assert_eq!(record.message().unwrap(), b"transfer {i3} lamports from {i0} to {i1}");
    }

    #[test]
    fn compiles_the_spl_token_transfer() {
        let bytes = compile_implementation(SPL_TOKEN_TRANSFER, &catalog()).unwrap();
        let record = Implementation::parse(&bytes).unwrap();
        let instructions = record.instructions().unwrap();
        let transfer_data = record.instruction_segments(instructions.get(1).unwrap()).unwrap();

        assert_eq!(instructions.len(), 2);
        assert!(matches!(record.accounts().unwrap().get(6).unwrap().address(), Ok(AddressSource::Ata { .. })));
        assert_eq!(
            transfer_data.get(2).unwrap().decode(),
            Ok(Segment::AccountBytes { account: 3, owner: 0, offset: 44, length: 1 })
        );
    }

    #[test]
    fn compiles_the_token_2022_builder_call() {
        let bytes = compile_implementation(TOKEN_2022_TRANSFER, &catalog()).unwrap();
        let record = Implementation::parse(&bytes).unwrap();
        let call = record.instructions().unwrap().first().unwrap();

        assert_eq!(record.recipe(), Ok(RecipeKind::Program));
        assert_eq!(record.instruction_accounts(call).unwrap(), &[0, 1, 2, 3, 4]);
        assert_eq!(record.instruction_segments(call).unwrap().len(), 3);
        assert_eq!(record.post_conditions().unwrap().len(), 1);
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
