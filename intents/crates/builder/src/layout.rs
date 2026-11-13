//! The bytes of each result, as the views of `sdp_intents_spec::builder` read them.

use alloc::vec::Vec;

use bytemuck::bytes_of;
use pinocchio::address::Address;
use sdp_intents_spec::builder::{
    AccountMetaV1, HashedReadyV1, InstructionHeaderV1, ReadyHeaderV1, ResultKind, ResultPointerV1, MAX_HASHED_TAIL,
};
use sdp_intents_spec::wire::{PodU16, PodU32};

use crate::{BuildError, Meta};

/// The instruction section: each `InstructionHeaderV1`, its `AccountMetaV1` entries, and its data.
#[derive(Default)]
pub(crate) struct Section {
    pub(crate) bytes: Vec<u8>,
    pub(crate) count: u8,
}

impl Section {
    pub(crate) fn push(&mut self, program: &Address, metas: &[Meta], data: &[u8]) -> Result<(), BuildError> {
        let header = InstructionHeaderV1 {
            program: spec_address(program),
            num_accounts: u8::try_from(metas.len()).map_err(|_| BuildError::TooLarge)?,
            data_len: PodU16::new(u16::try_from(data.len()).map_err(|_| BuildError::TooLarge)?),
        };

        self.count = self.count.checked_add(1).ok_or(BuildError::TooLarge)?;
        self.bytes.extend_from_slice(bytes_of(&header));

        for meta in metas {
            let account = AccountMetaV1 { address: spec_address(&meta.address), role: meta.role.into() };
            self.bytes.extend_from_slice(bytes_of(&account));
        }

        self.bytes.extend_from_slice(data);

        Ok(())
    }
}

/// `ReadyHeaderV1`, the outputs, no signers, the bumps, then the instruction section.
pub(crate) fn ready(section: &Section, outputs: &[u8], bumps: &[u8]) -> Result<Vec<u8>, BuildError> {
    let header = ReadyHeaderV1 {
        num_instructions: section.count,
        num_signers: 0,
        outputs_len: length(outputs.len())?,
        num_bumps: u8::try_from(bumps.len()).map_err(|_| BuildError::TooLarge)?,
    };

    Ok([bytes_of(&header), outputs, bumps, &section.bytes].concat())
}

pub(crate) fn more_accounts(addresses: &[Address]) -> Result<Vec<u8>, BuildError> {
    let count = u8::try_from(addresses.len()).map_err(|_| BuildError::TooLarge)?;
    let mut bytes = Vec::with_capacity(addresses.len().saturating_mul(32).saturating_add(1));
    bytes.push(count);
    addresses.iter().for_each(|address| bytes.extend_from_slice(address.as_ref()));

    Ok(bytes)
}

pub(crate) fn refused(code: &str, message: &str) -> Result<Vec<u8>, BuildError> {
    let code_len = u8::try_from(code.len()).map_err(|_| BuildError::TooLarge)?;

    Ok([&[code_len][..], &length(message.len())?.0, code.as_bytes(), message.as_bytes()].concat())
}

/// `HashedReadyV1`, then the outputs. The hash covers the instruction section, with the rent
/// placeholder in place, so the caller compares it with the instructions that it rebuilds.
pub(crate) fn hashed(section: &Section, outputs: &[u8]) -> Result<Vec<u8>, BuildError> {
    if outputs.len() > MAX_HASHED_TAIL {
        return Err(BuildError::TooLarge);
    }

    let fixed = HashedReadyV1 {
        kind: ResultKind::HashedReady.into(),
        instructions_hash: solana_sha256_hasher::hashv(&[&section.bytes]).to_bytes(),
        num_instructions: section.count,
        num_signers: 0,
        outputs_len: length(outputs.len())?,
    };

    Ok([bytes_of(&fixed), outputs].concat())
}

/// The return data of a staged result, which sits at offset 0 of scratch.
pub(crate) fn pointer(kind: ResultKind, account_index: u8, len: usize) -> Result<ResultPointerV1, BuildError> {
    Ok(ResultPointerV1 {
        kind: kind.into(),
        account_index,
        offset: PodU32::new(0),
        len: PodU32::new(u32::try_from(len).map_err(|_| BuildError::TooLarge)?),
    })
}

fn length(len: usize) -> Result<PodU16, BuildError> {
    u16::try_from(len).map(PodU16::new).map_err(|_| BuildError::TooLarge)
}

fn spec_address(address: &Address) -> sdp_intents_spec::Address {
    sdp_intents_spec::Address(address.to_bytes())
}

#[cfg(test)]
mod tests {
    extern crate std;

    use sdp_intents_spec::builder::{HashedReady, Ready, StagedResult};
    use sdp_intents_spec::AccountRole;

    use super::*;
    use crate::RENT_PAYER;

    fn transfer_section() -> Section {
        let mut section = Section::default();
        let program = Address::new_from_array([1; 32]);
        let metas = [Meta::writable(&Address::new_from_array([2; 32])), Meta::rent_payer()];
        section.push(&program, &metas, &[12, 0]).unwrap();

        section
    }

    #[test]
    fn a_ready_result_parses_with_the_spec_view() {
        let bytes = ready(&transfer_section(), &[7; 32], &[255, 253]).unwrap();
        let ready = Ready::parse(&bytes).unwrap();
        let instruction = ready.instructions().unwrap().next().unwrap().unwrap();

        assert_eq!(ready.outputs().unwrap(), [7; 32]);
        assert_eq!(ready.bumps().unwrap(), [255, 253]);
        assert_eq!(instruction.program.0, [1; 32]);
        assert_eq!(instruction.accounts.get(1).unwrap().address.0, RENT_PAYER.to_bytes());
        assert_eq!(instruction.accounts.get(1).unwrap().role(), Ok(AccountRole::WritableSigner));
        assert_eq!(instruction.data, [12, 0]);
    }

    #[test]
    fn a_staged_result_follows_its_pointer() {
        let addresses = [Address::new_from_array([5; 32])];
        let bytes = more_accounts(&addresses).unwrap();
        let pointer = pointer(ResultKind::MoreAccounts, 6, bytes.len()).unwrap();
        let scratch = [bytes.as_slice(), &[0; 64]].concat();

        let Ok(StagedResult::MoreAccounts(requested)) = StagedResult::parse(bytes_of(&pointer), &scratch) else {
            panic!("the result is not a request for accounts");
        };
        assert_eq!(requested, [sdp_intents_spec::Address([5; 32])]);

        let refusal = refused("vaultPaused", "the vault is paused").unwrap();
        let pointer = super::pointer(ResultKind::Refused, 6, refusal.len()).unwrap();
        let Ok(StagedResult::Refused(refused)) = StagedResult::parse(bytes_of(&pointer), &refusal) else {
            panic!("the result is not a refusal");
        };
        assert_eq!(refused.code, b"vaultPaused");
    }

    #[test]
    fn a_hashed_result_hashes_the_section_that_ready_holds() {
        let section = transfer_section();
        let hashed_bytes = hashed(&section, &[]).unwrap();
        let ready_bytes = ready(&section, &[], &[]).unwrap();

        let hashed = HashedReady::parse(&hashed_bytes).unwrap();
        let ready = Ready::parse(&ready_bytes).unwrap();
        let expected = solana_sha256_hasher::hashv(&[ready.instruction_section().unwrap()]).to_bytes();

        assert_eq!(hashed.fixed.instructions_hash, expected);
        assert!(super::hashed(&section, &[0; 989]).is_err());
    }
}
