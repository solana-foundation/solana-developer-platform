//! Yields the built instructions of a resolved recipe, one at a time. Nothing is copied out of the
//! documents or the chain, except an integer that an encoding widens.

use sdp_intents_spec::wire::{InstructionV1, SegmentV1};
use sdp_intents_spec::{AccountRole, Address};

use crate::value::{Bytes, Context};
use crate::{Chain, EngineError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuiltAccount<'r> {
    pub address: &'r Address,
    pub role: AccountRole,
}

pub struct BuiltInstruction<'r, C> {
    pub program: &'r Address,
    account_indexes: &'r [u8],
    /// The accounts that a builder asked for in earlier rounds, after the record's accounts.
    extra_accounts: &'r [Address],
    segments: &'r [SegmentV1],
    context: Context<'r, C>,
}

impl<'r, C: Chain> BuiltInstruction<'r, C> {
    pub fn accounts(&self) -> impl Iterator<Item = Result<BuiltAccount<'r>, EngineError>> + use<'r, C> {
        let context = self.context;
        let extra_accounts =
            self.extra_accounts.iter().map(|address| Ok(BuiltAccount { address, role: AccountRole::Readonly }));

        self.account_indexes
            .iter()
            .map(move |index| {
                let account = context.documents.implementation.accounts()?.get(usize::from(*index));
                let account = account.ok_or(EngineError::Unresolved { account: *index })?;
                let address = context.addresses.get(*index).ok_or(EngineError::Unresolved { account: *index })?;

                Ok(BuiltAccount { address, role: AccountRole::new(account.writable(), account.signer()) })
            })
            .chain(extra_accounts)
    }

    pub fn accounts_len(&self) -> usize {
        self.account_indexes.len().saturating_add(self.extra_accounts.len())
    }

    /// The segments of the data, in order. The data is their concatenation.
    pub fn data(&self) -> impl Iterator<Item = Result<Bytes<'r>, EngineError>> + use<'r, C> {
        let context = self.context;

        self.segments.iter().map(move |segment| context.segment(segment))
    }

    pub fn data_len(&self) -> Result<usize, EngineError> {
        self.data().try_fold(0usize, |len, bytes| {
            len.checked_add(bytes?.as_slice().len()).ok_or(EngineError::Spec(sdp_intents_spec::SpecError::OutOfBounds))
        })
    }
}

pub struct Instructions<'r, C> {
    context: Context<'r, C>,
    instructions: core::slice::Iter<'r, InstructionV1>,
}

impl<'r, C: Chain> Instructions<'r, C> {
    pub(crate) fn new(context: Context<'r, C>) -> Result<Self, EngineError> {
        let implementation = context.documents.implementation;

        Ok(Self { context, instructions: implementation.instructions()?.iter() })
    }
}

impl<'r, C: Chain> Iterator for Instructions<'r, C> {
    type Item = Result<BuiltInstruction<'r, C>, EngineError>;

    fn next(&mut self) -> Option<Self::Item> {
        let instruction = self.instructions.next()?;

        Some(build(self.context, instruction, &[]))
    }
}

pub(crate) fn build<'r, C: Chain>(
    context: Context<'r, C>,
    instruction: &'r InstructionV1,
    extra_accounts: &'r [Address],
) -> Result<BuiltInstruction<'r, C>, EngineError> {
    let implementation = context.documents.implementation;
    let program = instruction.program;

    Ok(BuiltInstruction {
        program: context.addresses.get(program).ok_or(EngineError::Unresolved { account: program })?,
        account_indexes: implementation.instruction_accounts(instruction)?,
        extra_accounts,
        segments: implementation.instruction_segments(instruction)?,
        context,
    })
}

#[cfg(test)]
mod tests {
    use sdp_intents_spec::AccountRole::{Readonly, ReadonlySigner, Writable, WritableSigner};

    use super::*;
    use crate::test_support::*;

    fn account(address: &Address, role: AccountRole) -> BuiltAccount<'_> {
        BuiltAccount { address, role }
    }

    #[test]
    fn builds_a_system_transfer() {
        let documents = Compiled::compile(SYSTEM_TRANSFER, INTENT_SYSTEM_TRANSFER);
        let mut chain = MapChain::default();
        let resolved = resolve_with_fetches(documents.recipe().unwrap(), &mut chain, &MapChain::default());

        let instructions: Vec<_> = resolved.recipe.instructions(&chain).unwrap().map(Result::unwrap).collect();
        let [transfer] = instructions.as_slice() else { panic!("one instruction") };
        let (from, to) = (address(FROM), address(TO));

        assert_eq!(resolved.fetches, 0);
        assert_eq!(transfer.program, &Address::default());
        assert_eq!(accounts_of(transfer), [account(&from, WritableSigner), account(&to, Writable)]);
        assert_eq!(data_of(transfer), [&[2, 0, 0, 0][..], &250_000_000u64.to_le_bytes()].concat());
        assert_eq!(transfer.data_len(), Ok(12));
    }

    #[test]
    fn builds_an_spl_transfer_after_one_fetch_of_the_mint() {
        let documents = Compiled::compile(SPL_TOKEN_TRANSFER, INTENT_SPL_TRANSFER);
        let mut source = MapChain::default();
        source.insert(address(USDC), address(TOKEN_PROGRAM), mint_data(6));

        let mut chain = MapChain::default();
        let resolved = resolve_with_fetches(documents.recipe().unwrap(), &mut chain, &source);
        let instructions: Vec<_> = resolved.recipe.instructions(&chain).unwrap().map(Result::unwrap).collect();
        let [create, transfer] = instructions.as_slice() else { panic!("two instructions") };

        let (from, to, payer, mint) = (address(FROM), address(TO), address(FEE_PAYER), address(USDC));
        let (system, token) = (Address::default(), address(TOKEN_PROGRAM));
        let source_ata = find_ata(FROM, USDC, TOKEN_PROGRAM);
        let destination_ata = find_ata(TO, USDC, TOKEN_PROGRAM);

        assert_eq!(resolved.fetches, 1);
        assert_eq!(create.program, &address(ASSOCIATED_TOKEN_PROGRAM));
        assert_eq!(
            accounts_of(create),
            [
                account(&payer, WritableSigner),
                account(&destination_ata, Writable),
                account(&to, Readonly),
                account(&mint, Readonly),
                account(&system, Readonly),
                account(&token, Readonly),
            ]
        );

        assert_eq!(data_of(create), [1]);

        assert_eq!(transfer.program, &token);
        assert_eq!(
            accounts_of(transfer),
            [
                account(&source_ata, Writable),
                account(&mint, Readonly),
                account(&destination_ata, Writable),
                account(&from, ReadonlySigner),
            ]
        );

        assert_eq!(data_of(transfer), [&[0x0c][..], &100_000_000u64.to_le_bytes(), &[6]].concat());
    }

    #[test]
    fn builds_the_token_2022_builder_call() {
        let documents = Compiled::compile(TOKEN_2022_TRANSFER, INTENT_TOKEN_2022_TRANSFER);
        let mint = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
        let mut source = MapChain::default();
        source.insert(address(mint), address(TOKEN_2022_PROGRAM), mint_data(6));

        let mut chain = MapChain::default();
        let resolved = resolve_with_fetches(documents.recipe().unwrap(), &mut chain, &source);
        let call = resolved.recipe.builder_call(&chain, &[]).unwrap();

        assert_eq!(resolved.fetches, 1);

        assert_eq!(call.program, &address("2gMFoKF3p5eB2m72ccjncZH8e5agVYbHBH8A29zDMdBm"));
        assert!(accounts_of(&call).iter().all(|account| account.role == Readonly));
        assert_eq!(accounts_of(&call).get(3).unwrap().address, &find_ata(FROM, mint, TOKEN_2022_PROGRAM));
        assert_eq!(
            data_of(&call),
            [&[0xbd, 0x1c, 0x9a, 0xdb, 0x8c, 0xa2, 0x62, 0x3c][..], &100_000_000u64.to_le_bytes(), &[0], &[0; 4]].concat()
        );

        let mut stated = resolved.recipe;
        stated.state_builder_bumps(&[254, 255]).unwrap();
        let call = stated.builder_call(&chain, &[]).unwrap();

        assert!(data_of(&call).ends_with(&[2, 0, 0, 0, 254, 255]));
    }

    fn resolved_token_2022<'d>(chain: &mut MapChain, documents: &'d Compiled) -> Resolved<'d> {
        let mint = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
        let mut source = MapChain::default();
        source.insert(address(mint), address(TOKEN_2022_PROGRAM), mint_data(6));

        resolve_with_fetches(documents.recipe().unwrap(), chain, &source)
    }

    #[test]
    fn a_builder_call_appends_the_accounts_of_earlier_rounds() {
        let documents = Compiled::compile(TOKEN_2022_TRANSFER, INTENT_TOKEN_2022_TRANSFER);
        let mut chain = MapChain::default();
        let resolved = resolved_token_2022(&mut chain, &documents);
        let hook_accounts = [Address([1; 32]), Address([2; 32])];

        let call = resolved.recipe.builder_call(&chain, &hook_accounts).unwrap();
        let accounts = accounts_of(&call);

        assert_eq!(accounts.len(), 7);
        assert_eq!(
            accounts.get(5..),
            Some(&[account(&hook_accounts[0], Readonly), account(&hook_accounts[1], Readonly)][..])
        );
    }

    #[test]
    fn a_builder_cannot_ask_for_a_payer_or_more_than_64_accounts() {
        let documents = Compiled::compile(TOKEN_2022_TRANSFER, INTENT_TOKEN_2022_TRANSFER);
        let mut chain = MapChain::default();
        let resolved = resolved_token_2022(&mut chain, &documents);

        let payer = [address(FEE_PAYER)];
        let many = [Address([1; 32]); 60];

        assert!(resolved.recipe.builder_call(&chain, &payer).is_err_and(|error| error == EngineError::PayerAccount));
        assert!(resolved.recipe.builder_call(&chain, &many).is_err_and(|error| error == EngineError::TooManyAccounts));
        assert!(resolved
            .recipe
            .instructions(&chain)
            .is_err_and(|error| matches!(error, EngineError::WrongRecipe { .. })));
    }

    #[test]
    fn instructions_wait_for_a_complete_resolve() {
        let documents = Compiled::compile(SPL_TOKEN_TRANSFER, INTENT_SPL_TRANSFER);
        let mut recipe = documents.recipe().unwrap();
        let chain = MapChain::default();

        assert!(recipe.instructions(&chain).is_err_and(|error| error == EngineError::NotResolved));
        assert_eq!(missing_of(recipe.resolve(&chain).unwrap()), [address(USDC)]);
        assert!(recipe.instructions(&chain).is_err_and(|error| error == EngineError::NotResolved));
    }
}
