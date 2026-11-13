//! `token.transfer` and one implementation of it in the registry, and `verify_intent` as a client
//! builds it by hand. The tests change that instruction, and compare the planner's with it.

use anchor_lang::Address;
use anchor_v2_testing::litesvm::LiteSVM;
use sdp_intents_compiler::Catalog;
use sdp_intents_engine::{Payers, Recipe, Resolution};
use sdp_intents_planner::{AccountMap, AccountMeta, Instruction, Plan, Transaction};
use sdp_intents_program_testing::{definitions, fetch, Documents};
use sdp_intents_spec::AccountRole;

use crate::fixture::{DocumentTarget, Organization};
use crate::svm::{failure, Failure};

/// The accounts of `verify_intent` before the record's.
pub struct VerifyAccounts {
    pub interface_index: Address,
    pub implementation_index: Address,
    pub interface_version: Address,
    pub implementation_version: Address,
}

pub struct Published {
    pub organization: Organization,
    pub accounts: VerifyAccounts,
    pub implementation: &'static str,
}

/// Publishes `token.transfer` and `implementation` under `solana.org`. The implementation is
/// approved when `approve` is set.
pub fn publish_transfer(svm: &mut LiteSVM, implementation: &'static str, approve: bool) -> Result<Published, Failure> {
    let organization = Organization::create(svm, "solana.org")?;
    let mut catalog = catalog(&organization);
    let interface_document = catalog.compile_interface(definitions::TOKEN_TRANSFER).map_err(report)?.bytes.clone();
    let compiled = catalog.compile_implementation(implementation).map_err(report)?;
    let implementation_name = compiled.id.name.clone();
    let implementation_document = compiled.bytes.clone();

    let interface_index = organization.create_interface(svm, "token.transfer")?;
    let interface_version = organization.publish(svm, "token.transfer", &interface_document, None)?;
    let implementation_index = organization.create_implementation(svm, &implementation_name, &interface_index)?;
    let implementation_version =
        organization.publish(svm, &implementation_name, &implementation_document, Some(interface_index))?;

    if approve {
        let version = DocumentTarget::of(&implementation_document)?.version;
        organization.approve(svm, &organization.approval(&interface_index, &implementation_index), &version)?;
    }

    let accounts = VerifyAccounts { interface_index, implementation_index, interface_version, implementation_version };

    Ok(Published { organization, accounts, implementation })
}

impl Published {
    /// The interface, the implementation, and `intent`, with the organization's address as the
    /// publisher. `fee_payer` pays the fee and the rent of the plan.
    pub fn compile(&self, intent: &str, fee_payer: &Address) -> Result<Documents, Failure> {
        let mut catalog = catalog(&self.organization);
        catalog.compile_interface(definitions::TOKEN_TRANSFER).map_err(report)?;
        catalog.compile_implementation(self.implementation).map_err(report)?;
        let compiled = catalog.compile_intent(intent).map_err(report)?;

        Ok(Documents {
            interface: compiled.interface.bytes.clone(),
            implementation: compiled.implementation.bytes.clone(),
            intent: compiled.bytes,
            fee_payer: spec_address(fee_payer),
        })
    }

    /// `verify_intent` for `documents`: the payers, the registry's accounts, the record's account table, then
    /// `extra_accounts`, the accounts of a builder's last round. `builder_roles` holds the builder's
    /// role of each account of its instructions, and is empty for a static recipe.
    pub fn verify_instruction(
        &self,
        svm: &LiteSVM,
        documents: &Documents,
        extra_accounts: &[Address],
        builder_roles: &[u8],
    ) -> Result<Instruction, Failure> {
        let accounts = &self.accounts;
        let fee_payer = Address::new_from_array(documents.fee_payer.0);
        let fixed = [
            pinocchio::sysvars::instructions::INSTRUCTIONS_ID,
            fee_payer,
            fee_payer,
            accounts.interface_index,
            accounts.implementation_index,
            accounts.interface_version,
            accounts.implementation_version,
        ];
        let record = record_accounts(svm, documents)?;
        let readonly = |address: &Address| AccountMeta { address: spec_address(address), role: AccountRole::Readonly };
        let data = anchor_lang::InstructionData::data(&registry::instruction::VerifyIntent {
            intent: &documents.intent,
            builder_roles,
        });

        Ok(Instruction {
            program: spec_address(&registry::ID),
            accounts: fixed.iter().chain(&record).chain(extra_accounts).map(readonly).collect(),
            data,
        })
    }
}

/// The role of each account of the plan's instructions, in order. A builder's plan holds the roles
/// of the builder's own instructions.
pub fn builder_roles(plan: &Plan) -> Vec<u8> {
    plan.transaction
        .instructions
        .iter()
        .flat_map(|instruction| instruction.accounts.iter().map(|meta| u8::from(meta.role)))
        .collect()
}

/// `plan` with `verify` first, and the highest budget, because the plan's budget does not include
/// `verify`.
pub fn with_verify(plan: &Plan, verify: Instruction) -> Plan {
    let instructions = std::iter::once(verify).chain(plan.transaction.instructions.iter().cloned()).collect();
    let budget = sdp_intents_planner::Budget {
        heap_size: plan.transaction.budget.heap_size,
        ..sdp_intents_planner::Budget::MAXIMUM
    };

    Plan { transaction: Transaction { instructions, budget, ..plan.transaction.clone() }, ..plan.clone() }
}

/// A transfer of the System program, as an instruction that no `verify_intent` covers.
pub fn system_transfer(from: &Address, to: &Address, lamports: u64) -> Instruction {
    const TRANSFER: u32 = 2;

    Instruction {
        program: spec_address(&crate::client::system_program()),
        accounts: vec![
            AccountMeta { address: spec_address(from), role: AccountRole::WritableSigner },
            AccountMeta { address: spec_address(to), role: AccountRole::Writable },
        ],
        data: [TRANSFER.to_le_bytes().as_slice(), &lamports.to_le_bytes()].concat(),
    }
}

/// `plan` with `before` first and `after` last.
pub fn around(plan: &Plan, before: Instruction, after: Instruction) -> Plan {
    let instructions =
        std::iter::once(before).chain(plan.transaction.instructions.iter().cloned()).chain([after]).collect();

    Plan { transaction: Transaction { instructions, ..plan.transaction.clone() }, ..plan.clone() }
}

/// The address of each account of the record's table, as the engine resolves it against `svm`.
fn record_accounts(svm: &LiteSVM, documents: &Documents) -> Result<Vec<Address>, Failure> {
    let payers = Payers { fee: &documents.fee_payer, rent: &documents.fee_payer };
    let mut recipe = Recipe::parse(&documents.interface, &documents.implementation, &documents.intent, payers)
        .map_err(|error| failure(error.to_string()))?;
    let mut chain = AccountMap::default();

    loop {
        let missing: Vec<_> = match recipe.resolve(&chain).map_err(|error| failure(error.to_string()))? {
            Resolution::Complete => break,
            Resolution::Missing(missing) => missing.addresses().copied().collect(),
        };
        let fetched = missing.iter().map(|address| fetch(svm, address)).collect();
        chain.insert_fetched(&missing, fetched);
    }

    let count = recipe.implementation().accounts().map_err(|error| failure(error.to_string()))?.len();

    (0u8..)
        .take(count)
        .map(|account| recipe.address(account).map(|address| Address::new_from_array(address.0)))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| failure("an account is not resolved".into()))
}

pub fn spec_address(address: &Address) -> sdp_intents_spec::Address {
    sdp_intents_spec::Address(address.to_bytes())
}

pub fn catalog(organization: &Organization) -> Catalog {
    Catalog::default().with_publisher(&organization.name, spec_address(&organization.address))
}

pub fn report(report: sdp_intents_compiler::diagnostic::Report) -> Failure {
    failure(format!("{report:?}"))
}
