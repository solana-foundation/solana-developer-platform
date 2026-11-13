//! The planner against the Token-2022 builder in LiteSVM, with mints that Token-2022 11 creates. Each
//! transfer that the builder returns is prepared with the real planner, then signed and sent.

mod support;

use anchor_v2_testing::Signer;
use sdp_intents_program_testing::built;
use spl_token_2022_interface::extension::transfer_fee::TransferFeeAmount;
use spl_token_2022_interface::extension::{BaseStateWithExtensions, StateWithExtensions};
use spl_token_2022_interface::state::Account as TokenAccountState;
use spl_token_2022_interface::{instruction as token_instruction, ID as TOKEN_2022};

use support::{ata, create_ata, hook, Chain, MintExtension, ASSOCIATED_TOKEN, HOOK_PROGRAM_ID, MEMO};

const FUNDED: u64 = 1_000_000;
const AMOUNT: u64 = 250_000;

/// A mint with `extensions`, and the sender's ATA with [`FUNDED`] tokens.
fn funded_mint(chain: &mut Chain, extensions: &[MintExtension]) -> Result<solana_address::Address, String> {
    let mint = chain.create_mint(extensions)?;
    let from = chain.wallets.from.pubkey();
    chain.fund(&from, &mint, FUNDED)?;

    Ok(mint)
}

#[test]
fn a_plain_mint_creates_the_destination_then_transfers() {
    let mut chain = Chain::new().unwrap();
    let mint = funded_mint(&mut chain, &[]).unwrap();

    let sent = chain.transfer(&mint, AMOUNT, None).unwrap();

    assert_eq!(sent.plan.intents[0].builder_simulations, 1);
    assert_eq!(sent.programs, [ASSOCIATED_TOKEN, TOKEN_2022]);
    assert_eq!(chain.token_amount(&ata(&chain.wallets.from.pubkey(), &mint)), Ok(FUNDED - AMOUNT));
    assert_eq!(chain.token_amount(&ata(&chain.wallets.to.pubkey(), &mint)), Ok(AMOUNT));
}

#[test]
fn an_existing_destination_gets_only_the_transfer() {
    let mut chain = Chain::new().unwrap();
    let mint = funded_mint(&mut chain, &[]).unwrap();
    let to = chain.wallets.to.pubkey();
    let destination = chain.fund(&to, &mint, 5).unwrap();

    let sent = chain.transfer(&mint, AMOUNT, None).unwrap();

    assert_eq!(sent.programs, [TOKEN_2022]);
    assert_eq!(chain.token_amount(&destination), Ok(AMOUNT + 5));
}

/// The extensions of PYUSD: a transfer fee, a permanent delegate, and a transfer hook with no
/// program. A fee of 1% is 2,500 of 250,000, under the maximum of 3,000.
#[test]
fn a_transfer_fee_is_withheld_from_what_the_recipient_receives() {
    let mut chain = Chain::new().unwrap();
    let extensions = [
        MintExtension::TransferFee { basis_points: 100, maximum_fee: 3_000 },
        MintExtension::PermanentDelegate,
        MintExtension::TransferHook(None),
    ];
    let mint = funded_mint(&mut chain, &extensions).unwrap();

    let sent = chain.transfer(&mint, AMOUNT, None).unwrap();

    let destination = ata(&chain.wallets.to.pubkey(), &mint);
    let data = chain.svm.get_account(&destination).unwrap().data;
    let state = StateWithExtensions::<TokenAccountState>::unpack(&data).unwrap();
    let withheld = u64::from(state.get_extension::<TransferFeeAmount>().unwrap().withheld_amount);

    assert_eq!(sent.plan.intents[0].builder_simulations, 1);
    assert_eq!(chain.token_amount(&ata(&chain.wallets.from.pubkey(), &mint)), Ok(FUNDED - AMOUNT));
    assert_eq!(state.base.amount, AMOUNT - 2_500);
    assert_eq!(withheld, 2_500);
}

#[test]
fn a_memo_comes_right_before_the_transfer_to_a_destination_that_requires_one() {
    let mut chain = Chain::new().unwrap();
    let mint = funded_mint(&mut chain, &[]).unwrap();
    let to = chain.wallets.to.pubkey();
    let destination = chain.fund(&to, &mint, 0).unwrap();
    chain.require_memos(&destination).unwrap();

    let sent = chain.transfer(&mint, AMOUNT, Some("invoice 42")).unwrap();

    assert_eq!(sent.programs, [MEMO, TOKEN_2022]);
    assert_eq!(built(&sent.plan)[0].data, b"invoice 42");
    assert_eq!(chain.token_amount(&destination), Ok(AMOUNT));
}

#[test]
fn a_memo_to_a_new_destination_follows_its_creation() {
    let mut chain = Chain::new().unwrap();
    let mint = funded_mint(&mut chain, &[]).unwrap();

    let sent = chain.transfer(&mint, AMOUNT, Some("thanks")).unwrap();

    assert_eq!(sent.programs, [ASSOCIATED_TOKEN, MEMO, TOKEN_2022]);
    assert_eq!(chain.token_amount(&ata(&chain.wallets.to.pubkey(), &mint)), Ok(AMOUNT));
}

/// The hook needs a round for its meta list and a round for the data of `config`, so the builder
/// runs three times.
#[test]
fn a_transfer_hook_resolves_its_accounts_in_rounds() {
    let mut chain = Chain::new().unwrap();
    let mint = funded_mint(&mut chain, &[MintExtension::TransferHook(Some(HOOK_PROGRAM_ID))]).unwrap();
    let hook_accounts = hook::install(&mut chain, &mint).unwrap();

    let sent = chain.transfer(&mint, AMOUNT, None).unwrap();

    let transfer = built(&sent.plan).last().unwrap();
    let appended: Vec<[u8; 32]> = transfer.accounts[4..].iter().map(|meta| meta.address.0).collect();
    let counter = chain.svm.get_account(&hook_accounts.counter).unwrap().data;

    assert_eq!(sent.plan.intents[0].builder_simulations, 3);
    assert_eq!(appended.len(), 5);
    assert_eq!(appended[1], hook_accounts.counter.to_bytes());
    assert!(transfer.accounts[5].role.writable());
    assert_eq!(appended[2], hook_accounts.treasury.to_bytes());
    assert_eq!(appended[3..], [HOOK_PROGRAM_ID.to_bytes(), hook_accounts.meta_list.to_bytes()]);
    assert_eq!(counter, 1u64.to_le_bytes());
    assert_eq!(chain.token_amount(&ata(&chain.wallets.to.pubkey(), &mint)), Ok(AMOUNT));
}

#[test]
fn a_transfer_hook_without_a_meta_list_is_refused() {
    let mut chain = Chain::new().unwrap();
    let mint = funded_mint(&mut chain, &[MintExtension::TransferHook(Some(HOOK_PROGRAM_ID))]).unwrap();

    assert_eq!(chain.refusal(&mint, AMOUNT, None), Ok("hookUnresolvable".into()));
}

#[test]
fn a_destination_that_requires_a_memo_refuses_a_transfer_without_one() {
    let mut chain = Chain::new().unwrap();
    let mint = funded_mint(&mut chain, &[]).unwrap();
    let to = chain.wallets.to.pubkey();
    let destination = chain.fund(&to, &mint, 0).unwrap();
    chain.require_memos(&destination).unwrap();

    assert_eq!(chain.refusal(&mint, AMOUNT, None), Ok("memoRequired".into()));
}

#[test]
fn a_non_transferable_mint_is_refused() {
    let mut chain = Chain::new().unwrap();
    let mint = funded_mint(&mut chain, &[MintExtension::NonTransferable]).unwrap();

    assert_eq!(chain.refusal(&mint, AMOUNT, None), Ok("nonTransferable".into()));
}

#[test]
fn a_paused_mint_is_refused() {
    let mut chain = Chain::new().unwrap();
    let mint = funded_mint(&mut chain, &[MintExtension::Pausable]).unwrap();
    chain.pause(&mint).unwrap();

    assert_eq!(chain.refusal(&mint, AMOUNT, None), Ok("mintPaused".into()));
}

#[test]
fn an_interest_bearing_mint_is_refused() {
    let mut chain = Chain::new().unwrap();
    let mint = funded_mint(&mut chain, &[MintExtension::InterestBearing]).unwrap();

    assert_eq!(chain.refusal(&mint, AMOUNT, None), Ok("interestBearing".into()));
}

#[test]
fn a_frozen_source_is_refused() {
    let mut chain = Chain::new().unwrap();
    let mint = funded_mint(&mut chain, &[]).unwrap();
    let source = ata(&chain.wallets.from.pubkey(), &mint);
    chain.freeze(&source, &mint).unwrap();

    assert_eq!(chain.refusal(&mint, AMOUNT, None), Ok("sourceFrozen".into()));
}

/// A new account of the mint starts frozen, so the destination that the transfer creates cannot
/// receive it.
#[test]
fn a_mint_that_freezes_new_accounts_is_refused() {
    let mut chain = Chain::new().unwrap();
    let mint = chain.create_mint(&[MintExtension::FrozenByDefault]).unwrap();
    let from = chain.wallets.from.pubkey();
    let authority = chain.wallets.authority.insecure_clone();
    let source = ata(&from, &mint);

    let create = create_ata(&chain.wallets.fee_payer.pubkey(), &from, &mint);
    let thaw = token_instruction::thaw_account(&TOKEN_2022, &source, &mint, &authority.pubkey(), &[]).unwrap();
    let mint_to = token_instruction::mint_to(&TOKEN_2022, &mint, &source, &authority.pubkey(), &[], FUNDED).unwrap();
    chain.execute(&[create, thaw, mint_to], &[&authority]).unwrap();

    assert_eq!(chain.refusal(&mint, AMOUNT, None), Ok("destinationFrozen".into()));
}

#[test]
fn more_than_the_sender_holds_is_refused() {
    let mut chain = Chain::new().unwrap();
    let mint = funded_mint(&mut chain, &[]).unwrap();

    assert_eq!(chain.refusal(&mint, FUNDED + 1, None), Ok("insufficientFunds".into()));
}

#[test]
fn a_sender_without_a_token_account_is_refused() {
    let mut chain = Chain::new().unwrap();
    let mint = chain.create_mint(&[]).unwrap();

    assert_eq!(chain.refusal(&mint, AMOUNT, None), Ok("noSourceAccount".into()));
}
