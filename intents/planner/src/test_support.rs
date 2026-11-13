//! Compiled example documents, and builder results written as a builder writes them.

use bytemuck::bytes_of;
use sdp_intents_compiler::Catalog;
use sdp_intents_spec::builder::{
    AccountMetaV1, InstructionHeaderV1, ReadyHeaderV1, ResultKind, ResultPointerV1, PAYER_RENT_PLACEHOLDER,
};
use sdp_intents_spec::wire::{PodU16, PodU32};
use sdp_intents_spec::{AccountRole, Address};

use crate::{Account, IntentDocuments, ReturnData, SimulationResult};

pub(crate) const BUILDER: Address = Address([0x42; 32]);
pub(crate) const SCRATCH: Address = Address([0x5c; 32]);

pub(crate) struct Compiled {
    pub(crate) interface: Vec<u8>,
    pub(crate) implementation: Vec<u8>,
    pub(crate) intent: Vec<u8>,
}

impl Compiled {
    pub(crate) fn documents(&self) -> IntentDocuments<'_> {
        IntentDocuments { interface: &self.interface, implementation: &self.implementation, intent: &self.intent }
    }

    pub(crate) fn compile(implementation: &str, intent: &str) -> Self {
        let mut catalog = Catalog::default().with_publisher("solana.org", Address([7; 32]));
        let interface = catalog
            .compile_interface(include_str!("../../definitions/solana.org/interfaces/token.transfer/1.0.0.json"));
        let interface = interface.unwrap().bytes.clone();
        let implementation = catalog.compile_implementation(implementation).unwrap().bytes.clone();

        Self { interface, implementation, intent: catalog.compile_intent(intent).unwrap().bytes }
    }

    pub(crate) fn system_transfer(intent: &str) -> Self {
        Self::compile(include_str!("../../definitions/solana.org/implementations/system-transfer/1.0.0.json"), intent)
    }

    pub(crate) fn spl_transfer() -> Self {
        Self::compile(
            include_str!("../../definitions/solana.org/implementations/spl-token-transfer/1.0.0.json"),
            include_str!("../../fixtures/intents/spl-token-transfer.json"),
        )
    }

    /// The Token-2022 record, with its builder at `BUILDER`.
    pub(crate) fn token_2022_transfer() -> Self {
        let record = include_str!("../../definitions/solana.org/implementations/token-2022-transfer/1.0.0.json");
        let builder = bs58::encode(BUILDER.0).into_string();

        Self::compile(
            &record.replace("2gMFoKF3p5eB2m72ccjncZH8e5agVYbHBH8A29zDMdBm", &builder),
            include_str!("../../fixtures/intents/token-2022-transfer.json"),
        )
    }
}

pub(crate) const SYSTEM_TRANSFER: &str = include_str!("../../fixtures/intents/system-transfer.json");

pub(crate) fn account(address: &str) -> Address {
    Address(bs58::decode(address).into_vec().unwrap().try_into().unwrap())
}

/// A staged result: the pointer in return data, and the result at offset 0 of scratch.
pub(crate) fn staged(kind: ResultKind, result: &[u8]) -> SimulationResult {
    let pointer = ResultPointerV1 {
        kind: kind.into(),
        account_index: 0,
        offset: PodU32::new(0),
        len: PodU32::new(u32::try_from(result.len()).unwrap()),
    };

    SimulationResult {
        return_data: Some(ReturnData { program: BUILDER, data: bytes_of(&pointer).to_vec() }),
        accounts: vec![Some(Account { owner: BUILDER, lamports: 72_161_280, data: [result, &[0; 64]].concat() })],
        ..SimulationResult::default()
    }
}

pub(crate) fn more_accounts(addresses: &[Address]) -> SimulationResult {
    let bytes: Vec<u8> = addresses.iter().flat_map(|address| address.0).collect();

    staged(ResultKind::MoreAccounts, &[&[u8::try_from(addresses.len()).unwrap()][..], &bytes].concat())
}

/// A `Ready` result with one transfer that the rent payer funds through the placeholder.
pub(crate) fn ready_with_rent_payer() -> SimulationResult {
    let header = ReadyHeaderV1 { num_instructions: 1, num_signers: 0, outputs_len: PodU16::new(0) };
    let instruction = InstructionHeaderV1 { program: Address::default(), num_accounts: 2, data_len: PodU16::new(1) };
    let payer = AccountMetaV1 { address: PAYER_RENT_PLACEHOLDER, role: AccountRole::WritableSigner.into() };
    let other = AccountMetaV1 { address: Address([3; 32]), role: AccountRole::Writable.into() };

    staged(
        ResultKind::Ready,
        &[bytes_of(&header), bytes_of(&instruction), bytes_of(&payer), bytes_of(&other), &[9]].concat(),
    )
}

pub(crate) fn refused(code: &str, message: &str) -> SimulationResult {
    let lengths =
        [&[u8::try_from(code.len()).unwrap()][..], &PodU16::new(u16::try_from(message.len()).unwrap()).0].concat();

    staged(ResultKind::Refused, &[&lengths[..], code.as_bytes(), message.as_bytes()].concat())
}

/// The 165 bytes of an SPL token account, with its mint, its owner, and its amount.
pub(crate) fn token_account(mint: Address, owner: Address, amount: u64) -> Vec<u8> {
    [&mint.0[..], &owner.0, &amount.to_le_bytes(), &[0; 165 - 72]].concat()
}
