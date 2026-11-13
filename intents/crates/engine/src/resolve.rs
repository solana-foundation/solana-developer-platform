//! Derives the address of each account of a recipe. One pass derives every account that the chain's
//! data allows, and names the accounts whose data the next pass needs.

use sdp_intents_spec::wire::{AccountV1, RangeV1};
use sdp_intents_spec::{Address, AddressSource, Segment, SpecError};

use crate::documents::Documents;
use crate::pda::{self, MAX_SEEDS};
use crate::value::{Bytes, Context};
use crate::{Chain, EngineError};

/// A record has at most 32 accounts.
const MAX_ACCOUNTS: usize = 32;

/// The address of each account of a recipe, in record order. It is about 1 KB, so a program can
/// hold it in one stack frame.
pub(crate) struct Addresses {
    slots: [Address; MAX_ACCOUNTS],
    resolved: AccountSet,
}

impl Default for Addresses {
    fn default() -> Self {
        Self { slots: [Address::default(); MAX_ACCOUNTS], resolved: AccountSet::default() }
    }
}

impl Addresses {
    pub(crate) fn get(&self, account: u8) -> Option<&Address> {
        self.resolved.contains(account).then(|| self.slots.get(usize::from(account))).flatten()
    }

    fn set(&mut self, account: u8, address: Address) {
        if let Some(slot) = self.slots.get_mut(usize::from(account)) {
            *slot = address;
            self.resolved.insert(account);
        }
    }
}

/// A set of account indexes of a record.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct AccountSet(u32);

impl AccountSet {
    pub(crate) fn contains(self, account: u8) -> bool {
        self.0 & bit(account) != 0
    }

    pub(crate) fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub(crate) fn iter(self) -> impl Iterator<Item = u8> {
        (0u8..32).filter(move |account| self.contains(*account))
    }

    fn insert(&mut self, account: u8) {
        self.0 |= bit(account);
    }

    /// Adds an account unless the set holds another account at the same address, so that a fetch
    /// asks for each address once.
    fn insert_address(&mut self, account: u8, addresses: &Addresses) {
        let address = addresses.get(account);
        let known = self.iter().any(|other| addresses.get(other) == address);

        if !known {
            self.insert(account);
        }
    }
}

fn bit(account: u8) -> u32 {
    1u32.checked_shl(u32::from(account)).unwrap_or(0)
}

impl Documents<'_> {
    /// Derives every address that the chain's data allows, and keeps those already derived. It
    /// returns the accounts whose data the next pass needs, with every `read` account that is
    /// resolved and not loaded.
    pub(crate) fn derive_addresses<C: Chain>(
        &self,
        addresses: &mut Addresses,
        chain: &C,
    ) -> Result<AccountSet, EngineError> {
        let accounts = self.implementation.accounts()?;

        if accounts.len() > MAX_ACCOUNTS {
            return Err(EngineError::Spec(SpecError::OutOfBounds));
        }

        let mut missing = AccountSet::default();

        for (account, index) in accounts.iter().zip(0u8..) {
            if addresses.get(index).is_some() {
                continue;
            }

            let derived = Context { documents: *self, addresses, chain }.derive(account, index);

            match derived {
                Ok(address) => addresses.set(index, address),
                Err(EngineError::MissingData { account }) => missing.insert_address(account, addresses),
                Err(EngineError::Unresolved { .. }) => {}
                Err(error) => return Err(error),
            }
        }

        self.add_unread_accounts(&mut missing, addresses, chain)?;

        Ok(missing)
    }

    /// The first account that is not resolved. Every wait ends at the data of a resolved account,
    /// so once nothing is missing, every account is resolved.
    pub(crate) fn first_unresolved(&self, addresses: &Addresses) -> Result<Option<u8>, EngineError> {
        let count = self.implementation.accounts()?.len();

        Ok((0u8..).take(count).find(|account| addresses.get(*account).is_none()))
    }

    fn add_unread_accounts<C: Chain>(
        &self,
        missing: &mut AccountSet,
        addresses: &Addresses,
        chain: &C,
    ) -> Result<(), EngineError> {
        for instruction in self.implementation.instructions()? {
            for segment in self.implementation.instruction_segments(instruction)? {
                let Segment::AccountBytes { account, .. } = segment.decode()? else {
                    continue;
                };

                if addresses.get(account).is_some_and(|address| chain.account(address).is_none()) {
                    missing.insert_address(account, addresses);
                }
            }
        }

        Ok(())
    }
}

impl<C: Chain> Context<'_, C> {
    fn derive(&self, account: &AccountV1, index: u8) -> Result<Address, EngineError> {
        let bad_seeds = EngineError::BadSeeds { account: index };

        match account.address()? {
            AddressSource::Value(value) => self.address(value).copied(),
            AddressSource::Static { address } => self.static_address(address).copied(),
            AddressSource::Pda { program, seeds } => self.pda(self.address(program)?, seeds, index),
            AddressSource::Ata { owner, mint, token_program } => {
                let [owner, mint, token_program] =
                    [owner, mint, token_program].map(|value| self.address(value)).map(|address| address.copied());

                pda::associated_token_account(&owner?, &mint?, &token_program?).ok_or(bad_seeds)
            }
            AddressSource::HasOne { account, owner, offset } => {
                let data = self.account_data(account, owner)?;
                let bytes = data.get(usize::from(offset)..).and_then(<[u8]>::first_chunk::<32>);

                bytes.map(|bytes| Address(*bytes)).ok_or(EngineError::ShortData { account })
            }
        }
    }

    fn pda(&self, program: &Address, seeds: RangeV1, account: u8) -> Result<Address, EngineError> {
        let bad_seeds = EngineError::BadSeeds { account };
        let seeds = self.documents.implementation.seeds(seeds)?;
        let mut parts = [Bytes::EMPTY; MAX_SEEDS];
        let parts = parts.get_mut(..seeds.len()).ok_or(bad_seeds)?;

        for (part, seed) in parts.iter_mut().zip(seeds) {
            *part = self.segment(seed)?;
        }

        pda::find(parts, program).ok_or(bad_seeds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;

    const VAULT: &str = "Vau1tAqmKCSRYZ9JYTUHiNpw6ULhe4bvfKnX2KfjS7h";
    const VAULT_PROGRAM: &str = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";

    /// The vault's authority is the 32 bytes at offset 8 of the vault, and the deposit goes to the
    /// authority's token account and a PDA of the depositor.
    fn vault_record() -> String {
        format!(
            r#"{{
  "spec": "sdp-intents@1.0",
  "kind": "implementation",
  "id": "solana.org/vault-transfer",
  "version": "1.0.0",
  "cluster": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  "implements": "solana.org/token.transfer@^1",
  "message": "deposit {{inputs.amount}}",
  "recipe": {{
    "kind": "static",
    "accounts": [
      {{ "name": "from", "address": "{{inputs.from}}", "signer": true }},
      {{ "name": "vault", "address": "{VAULT}" }},
      {{ "name": "authority", "address": {{ "hasOne": {{ "account": "{{accounts.vault}}", "owner": "{VAULT_PROGRAM}", "offset": "8" }} }} }},
      {{ "name": "authorityAta", "writable": true,
         "address": {{ "ata": {{ "owner": "{{accounts.authority}}", "mint": "{{inputs.mint}}", "tokenProgram": "{TOKEN_PROGRAM}" }} }} }},
      {{ "name": "receipt", "writable": true,
         "address": {{ "pda": {{ "program": "{VAULT_PROGRAM}", "seeds": [
           {{ "value": "receipt", "encoding": "utf8" }},
           {{ "value": "{{inputs.from}}", "encoding": "address" }},
           {{ "value": "{{inputs.amount}}", "encoding": "u64le" }}
         ] }} }} }}
    ],
    "instructions": [
      {{ "program": "{VAULT_PROGRAM}", "accounts": ["from", "vault", "authority", "authorityAta", "receipt"],
         "data": [{{ "value": "01", "encoding": "hex" }}] }}
    ]
  }}
}}"#
        )
    }

    fn vault_intent() -> String {
        INTENT_SPL_TRANSFER.replace("solana.org/spl-token-transfer@^1", "solana.org/vault-transfer@^1")
    }

    fn vault_data(authority: &Address) -> Vec<u8> {
        [&[0u8; 8][..], &authority.0, &[0; 16]].concat()
    }

    #[test]
    fn a_has_one_waits_for_one_fetch() {
        let documents = Compiled::compile(&vault_record(), &vault_intent());
        let authority = address(TO);
        let mut source = MapChain::default();
        source.insert(address(VAULT), address(VAULT_PROGRAM), vault_data(&authority));

        let mut first = documents.recipe().unwrap();

        assert_eq!(missing_of(first.resolve(&MapChain::default()).unwrap()), [address(VAULT)]);
        assert!(first.address(0).is_some() && first.address(2).is_none());

        let resolved = resolve_with_fetches(documents.recipe().unwrap(), &mut MapChain::default(), &source);
        let seeds = [&b"receipt"[..], &address(FROM).0, &100_000_000u64.to_le_bytes()];
        let program = solana_address::Address::new_from_array(address(VAULT_PROGRAM).0);
        let (receipt, _) = solana_address::Address::find_program_address(&seeds, &program);

        assert_eq!(resolved.fetches, 1);
        assert_eq!(resolved.recipe.address(2), Some(&authority));
        assert_eq!(resolved.recipe.address(3), Some(&find_ata(TO, USDC, TOKEN_PROGRAM)));
        assert_eq!(resolved.recipe.address(4), Some(&Address(receipt.to_bytes())));
    }

    #[test]
    fn a_read_joins_the_fetch_of_the_has_one() {
        let mint = r#"{ "name": "mint", "address": "{inputs.mint}" },
      { "name": "vault","#;
        let read = format!(
            r#"{{ "read": {{ "account": "{{accounts.mint}}", "owner": "{TOKEN_PROGRAM}", "offset": "44", "length": "1" }} }}"#
        );
        let record = vault_record().replace(r#"{ "name": "vault","#, mint).replace(
            r#"[{ "value": "01", "encoding": "hex" }]"#,
            &format!(r#"[{{ "value": "01", "encoding": "hex" }}, {read}]"#),
        );
        let documents = Compiled::compile(&record, &vault_intent());
        let mut source = MapChain::default();
        source.insert(address(VAULT), address(VAULT_PROGRAM), vault_data(&address(TO)));
        source.insert(address(USDC), address(TOKEN_PROGRAM), mint_data(6));

        let mut first = documents.recipe().unwrap();

        assert_eq!(missing_of(first.resolve(&MapChain::default()).unwrap()), [address(USDC), address(VAULT)]);
        assert_eq!(resolve_with_fetches(documents.recipe().unwrap(), &mut MapChain::default(), &source).fetches, 1);
    }

    #[test]
    fn a_has_one_refuses_an_account_of_another_owner() {
        let documents = Compiled::compile(&vault_record(), &vault_intent());
        let mut recipe = documents.recipe().unwrap();
        let mut chain = MapChain::default();
        chain.insert(address(VAULT), address(TOKEN_PROGRAM), vault_data(&address(TO)));

        assert!(recipe.resolve(&chain).is_err_and(|error| error == EngineError::WrongOwner { account: 1 }));
    }

    #[test]
    fn the_address_table_fits_a_stack_frame() {
        assert!(core::mem::size_of::<Addresses>() <= 1_040);
    }
}
