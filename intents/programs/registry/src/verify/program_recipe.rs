//! A program recipe: the builder runs again by CPI in hashed mode, and its hash must equal the
//! SHA-256 of the sysvar's instructions in the layout of the instruction section.
//!
//! The section names the rent payer with the placeholder, as the builder does. Only the rent payer
//! maps back, and the fee payer never appears, so the mapping is exact. A builder that names the
//! rent payer's address as an input address also maps, and fails the check.
//!
//! The sysvar holds each account's role in the transaction, which can differ from its role in the
//! builder's instruction. So the data of `verify_intent` holds the builder's roles, one byte for each
//! account of the section. The section takes those roles, so the hash proves them, and each
//! account's role in the sysvar must be their union, as [`super::roles`] gives it.

use alloc::vec::Vec;
use core::ops::Range;

use anchor_lang::prelude::*;
use pinocchio::cpi::{get_return_data, invoke_with_slice};
use pinocchio::instruction::{InstructionAccount, InstructionView};
use pinocchio::sysvars::instructions::IntrospectedInstruction;
use sdp_intents_engine::{Payers, Recipe};
use sdp_intents_spec::builder::{AccountMetaV1, HashedReady, InstructionHeaderV1, PAYER_RENT_PLACEHOLDER};
use sdp_intents_spec::wire::PodU16;
use sdp_intents_spec::AccountRole;

use crate::error::RegistryError;
use crate::state::spec_address;
use crate::verify::chain::PassedAccounts;
use crate::verify::refused;
use crate::verify::roles::TransactionRoles;

/// The call of the builder, in the form that a CPI takes.
struct BuilderCall<'a> {
    program: Address,
    data: Vec<u8>,
    accounts: Vec<&'a AccountView>,
}

/// `chain` holds the record's accounts, then the accounts of the builder's last round.
pub fn verify(
    recipe: &Recipe<'_>,
    chain: &PassedAccounts<'_>,
    sysvar: &SysvarInstructions,
    built: Range<usize>,
    builder_roles: &[u8],
) -> Result<()> {
    let call = builder_call(recipe, chain)?;
    call.invoke()?;

    let return_data = get_return_data().ok_or(RegistryError::BadBuilderResult)?;
    require!(*return_data.program_id() == call.program, RegistryError::BadBuilderResult);

    let hashed = HashedReady::parse(return_data.as_slice()).map_err(|_| RegistryError::BadBuilderResult)?;
    let section = instruction_section(sysvar, built.clone(), recipe.payers(), builder_roles)?;
    require!(
        anchor_lang::sha256(&section.bytes) == hashed.fixed.instructions_hash,
        RegistryError::WrongInstructionsHash
    );
    check_roles(sysvar, built.clone(), &section.roles)?;

    let signs = |signer: &sdp_intents_spec::Address| {
        built.clone().any(|position| {
            sysvar.load_instruction_at(position).is_ok_and(|instruction| names_signer(&instruction, signer))
        })
    };

    require!(hashed.signers.iter().all(signs), RegistryError::UnsignedBuilderSigner);

    Ok(())
}

fn builder_call<'a>(recipe: &Recipe<'_>, chain: &PassedAccounts<'a>) -> Result<BuilderCall<'a>> {
    let table_len = recipe.implementation().accounts().map_err(|error| refused(error.into()))?.len();
    let extra_accounts: Vec<sdp_intents_spec::Address> =
        chain.views.get(table_len..).unwrap_or_default().iter().map(|view| spec_address(view.address())).collect();
    let call = recipe.builder_call(chain, &extra_accounts).map_err(refused)?;

    let data = call.data().try_fold(Vec::new(), |mut data, segment| {
        data.extend_from_slice(segment.map_err(refused)?.as_slice());

        Ok::<Vec<u8>, anchor_lang::Error>(data)
    })?;

    let accounts = call
        .accounts()
        .map(|account| {
            let account = account.map_err(refused)?;

            chain.view(account.address).ok_or(RegistryError::WrongRecipeAccount.into())
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(BuilderCall { program: Address::new_from_array(call.program.0), data, accounts })
}

impl BuilderCall<'_> {
    /// Every account is readonly and unsigned, so the builder can change nothing.
    fn invoke(&self) -> Result<()> {
        let metas: Vec<InstructionAccount<'_>> =
            self.accounts.iter().map(|view| InstructionAccount::readonly(view.address())).collect();
        let instruction = InstructionView { program_id: &self.program, data: &self.data, accounts: &metas };

        invoke_with_slice(&instruction, &self.accounts)
    }
}

/// The instructions at `built` in the layout of the instruction section, and the union of each
/// account's roles in them.
struct Section {
    bytes: Vec<u8>,
    roles: TransactionRoles,
}

/// Each account takes its role from `builder_roles`, in order, which must hold one role for each
/// account.
fn instruction_section(
    sysvar: &SysvarInstructions,
    built: Range<usize>,
    payers: Payers<'_>,
    builder_roles: &[u8],
) -> Result<Section> {
    let mut section = Section { bytes: Vec::new(), roles: TransactionRoles::new(payers.fee) };
    let mut roles = builder_roles.iter();

    for position in built {
        let instruction = sysvar.load_instruction_at(position)?;
        let data = instruction.get_instruction_data();
        let header = InstructionHeaderV1 {
            program: spec_address(instruction.get_program_id()),
            num_accounts: u8::try_from(instruction.num_account_metas()).map_err(|_| RegistryError::WrongInstruction)?,
            data_len: PodU16::new(u16::try_from(data.len()).map_err(|_| RegistryError::WrongInstruction)?),
        };
        section.bytes.extend_from_slice(bytemuck::bytes_of(&header));

        for account in 0..instruction.num_account_metas() {
            let address = spec_address(&instruction.get_instruction_account_at(account)?.key);
            let role = roles.next().and_then(|role| AccountRole::try_from(*role).ok());
            let role = role.ok_or(RegistryError::WrongBuilderRoles)?;
            let placed = if address == *payers.rent { PAYER_RENT_PLACEHOLDER } else { address };

            section.roles.add(&address, role);
            section.bytes.extend_from_slice(bytemuck::bytes_of(&AccountMetaV1 { address: placed, role: role.into() }));
        }

        section.bytes.extend_from_slice(data);
    }

    require!(roles.next().is_none(), RegistryError::WrongBuilderRoles);

    Ok(section)
}

fn check_roles(sysvar: &SysvarInstructions, built: Range<usize>, roles: &TransactionRoles) -> Result<()> {
    for position in built {
        let instruction = sysvar.load_instruction_at(position)?;

        for account in 0..instruction.num_account_metas() {
            let meta = instruction.get_instruction_account_at(account)?;
            let role = AccountRole::new(meta.is_writable(), meta.is_signer());

            require!(role == roles.role(&spec_address(&meta.key)), RegistryError::WrongRole);
        }
    }

    Ok(())
}

fn names_signer(instruction: &IntrospectedInstruction<'_>, signer: &sdp_intents_spec::Address) -> bool {
    (0..instruction.num_account_metas()).any(|account| {
        instruction
            .get_instruction_account_at(account)
            .is_ok_and(|meta| meta.is_signer() && meta.key.as_ref() == signer.0)
    })
}
