//! Compiles the definitions and the example intents, and holds accounts for the engine to read.

use std::collections::HashMap;

use sdp_intents_compiler::Catalog;
use sdp_intents_spec::Address;

use crate::{AccountData, Chain, Recipe, Resolution};

pub(crate) const TOKEN_TRANSFER: &str =
    include_str!("../../definitions/solana.org/interfaces/token.transfer/1.0.0.json");
pub(crate) const SYSTEM_TRANSFER: &str =
    include_str!("../../definitions/solana.org/implementations/system-transfer/1.0.0.json");
pub(crate) const SPL_TOKEN_TRANSFER: &str =
    include_str!("../../definitions/solana.org/implementations/spl-token-transfer/1.0.0.json");
pub(crate) const TOKEN_2022_TRANSFER: &str =
    include_str!("../../definitions/solana.org/implementations/token-2022-transfer/1.0.0.json");

pub(crate) const INTENT_SYSTEM_TRANSFER: &str = include_str!("../../fixtures/intents/system-transfer.json");
pub(crate) const INTENT_SPL_TRANSFER: &str = include_str!("../../fixtures/intents/spl-token-transfer.json");
pub(crate) const INTENT_TOKEN_2022_TRANSFER: &str = include_str!("../../fixtures/intents/token-2022-transfer.json");

pub(crate) const FROM: &str = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
pub(crate) const TO: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
pub(crate) const FEE_PAYER: &str = "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG";
pub(crate) const USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub(crate) const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub(crate) const TOKEN_2022_PROGRAM: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
pub(crate) const ASSOCIATED_TOKEN_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

pub(crate) fn address(text: &str) -> Address {
    let address: solana_address::Address = text.parse().unwrap();

    Address(address.to_bytes())
}

/// The three documents of one intent, compiled.
pub(crate) struct Compiled {
    pub(crate) interface: Vec<u8>,
    pub(crate) implementation: Vec<u8>,
    pub(crate) intent: Vec<u8>,
}

impl Compiled {
    pub(crate) fn compile(implementation: &str, intent: &str) -> Self {
        let mut catalog = Catalog::default().with_publisher("solana.org", Address([7; 32]));
        let interface = catalog.compile_interface(TOKEN_TRANSFER).unwrap().bytes.clone();
        let implementation = catalog.compile_implementation(implementation).unwrap().bytes.clone();

        Self { interface, implementation, intent: catalog.compile_intent(intent).unwrap().bytes }
    }

    pub(crate) fn recipe(&self) -> Result<Recipe<'_>, crate::EngineError> {
        Recipe::parse(&self.interface, &self.implementation, &self.intent)
    }
}

/// Accounts by address, as the service's cache holds them.
#[derive(Default)]
pub(crate) struct MapChain {
    accounts: HashMap<Address, (Address, Vec<u8>)>,
}

impl MapChain {
    pub(crate) fn insert(&mut self, address: Address, owner: Address, data: Vec<u8>) {
        self.accounts.insert(address, (owner, data));
    }
}

impl Chain for MapChain {
    fn account(&self, address: &Address) -> Option<AccountData<'_>> {
        self.accounts.get(address).map(|(owner, data)| AccountData { owner, data, lamports: 1_000_000 })
    }
}

/// An SPL Token mint with 6 decimals. The decimals are byte 44.
pub(crate) fn mint_data(decimals: u8) -> Vec<u8> {
    let mut data = vec![0; 82];
    *data.get_mut(44).unwrap() = decimals;

    data
}

pub(crate) struct Resolved<'a> {
    pub(crate) recipe: Recipe<'a>,
    /// The calls that returned `Missing`, each one `getMultipleAccounts` for the service.
    pub(crate) fetches: usize,
}

/// Resolves as the service does: each `Missing` answer is one fetch from `source` into `chain`.
pub(crate) fn resolve_with_fetches<'a>(
    mut recipe: Recipe<'a>,
    chain: &mut MapChain,
    source: &MapChain,
) -> Resolved<'a> {
    let mut fetches = 0usize;

    while let Resolution::Missing(missing) = recipe.resolve(chain).unwrap() {
        fetches = fetches.saturating_add(1);
        assert!(fetches <= 4, "resolution does not converge");

        for address in missing.addresses() {
            let (owner, data) = source.accounts.get(address).unwrap().clone();
            chain.insert(*address, owner, data);
        }
    }

    Resolved { recipe, fetches }
}

/// The addresses that a resolve asks for.
pub(crate) fn missing_of(resolution: Resolution<'_>) -> Vec<Address> {
    match resolution {
        Resolution::Missing(missing) => missing.addresses().copied().collect(),
        Resolution::Complete => Vec::new(),
    }
}

/// The data of each instruction, joined.
pub(crate) fn data_of<C: Chain>(instruction: &crate::BuiltInstruction<'_, C>) -> Vec<u8> {
    instruction.data().map(|bytes| bytes.unwrap().as_slice().to_vec()).collect::<Vec<_>>().concat()
}

pub(crate) fn accounts_of<'r, C: Chain>(instruction: &crate::BuiltInstruction<'r, C>) -> Vec<crate::BuiltAccount<'r>> {
    instruction.accounts().map(|account| account.unwrap()).collect()
}

pub(crate) fn find_ata(owner: &str, mint: &str, token_program: &str) -> Address {
    let seeds = [address(owner).0, address(token_program).0, address(mint).0];
    let program = solana_address::Address::new_from_array(address(ASSOCIATED_TOKEN_PROGRAM).0);
    let (found, _) = solana_address::Address::find_program_address(&seeds.each_ref().map(|seed| &seed[..]), &program);

    Address(found.to_bytes())
}
