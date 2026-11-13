//! Token-2022 mints and accounts in LiteSVM, and the planner against the builder.

use anchor_v2_testing::litesvm::LiteSVM;
use anchor_v2_testing::{Keypair, Message, Signer, VersionedMessage, VersionedTransaction};
use sdp_intents_planner::{Plan, PlanError};
use sdp_intents_program_testing::{definitions, prepare, send, svm, Documents};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use spl_token_2022_interface::extension::{
    default_account_state, interest_bearing_mint, memo_transfer, pausable, transfer_fee, transfer_hook, ExtensionType,
};
use spl_token_2022_interface::state::{AccountState, Mint};
use spl_token_2022_interface::{instruction as token_instruction, ID as TOKEN_2022};

pub mod hook;

const BUILDER_PROGRAM: &[u8] = include_bytes!("../../../target/deploy/token_2022_builder.so");
const HOOK_PROGRAM: &[u8] = include_bytes!("../../../target/deploy/test_transfer_hook.so");
pub const HOOK_PROGRAM_ID: Address = Address::from_str_const("9dRuqr7dtKTnPJacira1fasr8q7HddDhPfzf2jGAuvQv");
pub const ASSOCIATED_TOKEN: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const MEMO: Address = Address::from_str_const("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const SYSTEM: Address = Address::new_from_array([0; 32]);

const SOL: u64 = 1_000_000_000;
const DECIMALS: u8 = 6;
const TOKEN_AMOUNT_OFFSET: usize = 64;

pub struct Wallets {
    pub fee_payer: Keypair,
    pub from: Keypair,
    pub to: Keypair,
    /// The mint authority, the freeze authority, and the authority of each mint extension.
    pub authority: Keypair,
}

pub struct Chain {
    pub svm: LiteSVM,
    pub wallets: Wallets,
}

#[derive(Clone, Copy, Debug)]
pub enum MintExtension {
    TransferFee { basis_points: u16, maximum_fee: u64 },
    TransferHook(Option<Address>),
    PermanentDelegate,
    NonTransferable,
    Pausable,
    FrozenByDefault,
    InterestBearing,
}

/// A plan that the chain ran, and the program of each of its instructions.
pub struct Sent {
    pub plan: Plan,
    pub programs: Vec<Address>,
}

impl Chain {
    pub fn new() -> Result<Self, String> {
        let mut svm = svm();
        svm.add_program(token_2022_builder::id(), BUILDER_PROGRAM).map_err(|error| format!("{error:?}"))?;
        svm.add_program(HOOK_PROGRAM_ID, HOOK_PROGRAM).map_err(|error| format!("{error:?}"))?;

        let wallets =
            Wallets { fee_payer: Keypair::new(), from: Keypair::new(), to: Keypair::new(), authority: Keypair::new() };

        for wallet in [&wallets.fee_payer, &wallets.from, &wallets.authority] {
            svm.airdrop(&wallet.pubkey(), 10 * SOL).map_err(|failed| format!("{:?}", failed.err))?;
        }

        Ok(Self { svm, wallets })
    }

    /// Signs with the fee payer, then `signers`.
    pub fn execute(&mut self, instructions: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        let payer = &self.wallets.fee_payer;
        let message = Message::new_with_blockhash(instructions, Some(&payer.pubkey()), &self.svm.latest_blockhash());
        let all_signers: Vec<&Keypair> = [payer].into_iter().chain(signers.iter().copied()).collect();
        let transaction = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &all_signers)
            .map_err(|error| error.to_string())?;

        self.svm.send_transaction(transaction).map(|_| ()).map_err(|failed| format!("{:?}", failed.err))
    }

    pub fn create_mint(&mut self, extensions: &[MintExtension]) -> Result<Address, String> {
        let mint = Keypair::new();
        let authority = self.wallets.authority.pubkey();
        let kinds: Vec<ExtensionType> = extensions.iter().map(|extension| extension.kind()).collect();
        let space = ExtensionType::try_calculate_account_len::<Mint>(&kinds).map_err(|error| format!("{error:?}"))?;

        let create = create_account(&self.wallets.fee_payer.pubkey(), &mint.pubkey(), self.rent(space), space);
        let initialize_extensions: Vec<Instruction> = extensions
            .iter()
            .map(|extension| extension.initialize(&mint.pubkey(), &authority))
            .collect::<Result<_, _>>()?;
        let initialize_mint =
            token_instruction::initialize_mint2(&TOKEN_2022, &mint.pubkey(), &authority, Some(&authority), DECIMALS)
                .map_err(|error| format!("{error:?}"))?;

        let instructions: Vec<Instruction> =
            [create].into_iter().chain(initialize_extensions).chain([initialize_mint]).collect();

        self.execute(&instructions, &[&mint])?;

        Ok(mint.pubkey())
    }

    /// Creates the ATA of `owner`, and mints `amount` to it.
    pub fn fund(&mut self, owner: &Address, mint: &Address, amount: u64) -> Result<Address, String> {
        let account = ata(owner, mint);
        let authority = self.wallets.authority.insecure_clone();
        let create = create_ata(&self.wallets.fee_payer.pubkey(), owner, mint);
        let mint_to = token_instruction::mint_to(&TOKEN_2022, mint, &account, &authority.pubkey(), &[], amount)
            .map_err(|error| format!("{error:?}"))?;

        self.execute(&[create, mint_to], &[&authority])?;

        Ok(account)
    }

    pub fn pause(&mut self, mint: &Address) -> Result<(), String> {
        let authority = self.wallets.authority.insecure_clone();
        let pause = pausable::instruction::pause(&TOKEN_2022, mint, &authority.pubkey(), &[])
            .map_err(|error| format!("{error:?}"))?;

        self.execute(&[pause], &[&authority])
    }

    pub fn freeze(&mut self, account: &Address, mint: &Address) -> Result<(), String> {
        let authority = self.wallets.authority.insecure_clone();
        let freeze = token_instruction::freeze_account(&TOKEN_2022, account, mint, &authority.pubkey(), &[])
            .map_err(|error| format!("{error:?}"))?;

        self.execute(&[freeze], &[&authority])
    }

    /// Makes the recipient's token account require a memo on each incoming transfer.
    pub fn require_memos(&mut self, account: &Address) -> Result<(), String> {
        let owner = self.wallets.to.insecure_clone();
        let payer = self.wallets.fee_payer.pubkey();
        let extensions = [ExtensionType::MemoTransfer];
        let reallocate = token_instruction::reallocate(&TOKEN_2022, account, &payer, &owner.pubkey(), &[], &extensions)
            .map_err(|error| format!("{error:?}"))?;

        let enable =
            memo_transfer::instruction::enable_required_transfer_memos(&TOKEN_2022, account, &owner.pubkey(), &[])
                .map_err(|error| format!("{error:?}"))?;

        self.execute(&[reallocate, enable], &[&owner])
    }

    pub fn rent(&self, space: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(space)
    }

    pub fn set_account(&mut self, address: Address, owner: &Address, data: Vec<u8>) -> Result<(), String> {
        let account =
            Account { lamports: self.rent(data.len()), data, owner: *owner, executable: false, rent_epoch: 0 };

        self.svm.set_account(address, account).map_err(|error| format!("{error:?}"))
    }

    pub fn token_amount(&self, account: &Address) -> Result<u64, String> {
        let data = self.svm.get_account(account).ok_or("no token account")?.data;
        let amount = data.get(TOKEN_AMOUNT_OFFSET..).and_then(|rest| rest.first_chunk::<8>()).ok_or("short data")?;

        Ok(u64::from_le_bytes(*amount))
    }

    pub fn documents(&self, mint: &Address, amount: u64, memo: Option<&str>) -> Result<Documents, String> {
        Documents::compile(
            &[definitions::TOKEN_TRANSFER],
            &[definitions::TOKEN_2022_TRANSFER],
            &self.intent(mint, amount, memo),
            &self.wallets.fee_payer.pubkey(),
        )
    }

    fn intent(&self, mint: &Address, amount: u64, memo: Option<&str>) -> String {
        let memo = memo.map(|text| format!(r#", "memo": "{text}""#)).unwrap_or_default();

        format!(
            r#"{{
  "spec": "sdp-intents@1.0",
  "kind": "intent",
  "interface": "solana.org/token.transfer@^1",
  "implementation": "solana.org/token-2022-transfer@^1",
  "inputs": {{ "from": "{}", "to": "{}", "mint": "{mint}", "amount": "{amount}"{memo} }},
  "options": {{ "assertions": false, "verifyIntent": false }}
}}"#,
            self.wallets.from.pubkey(),
            self.wallets.to.pubkey(),
        )
    }

    /// Prepares the transfer and sends the plan, signed by the fee payer and `from`.
    pub fn transfer(&mut self, mint: &Address, amount: u64, memo: Option<&str>) -> Result<Sent, String> {
        let documents = self.documents(mint, amount, memo)?;
        let plan = prepare(&self.svm, &documents).map_err(|error| format!("{error:?}"))?;

        send(&mut self.svm, &plan, &[&self.wallets.fee_payer, &self.wallets.from])
            .map_err(|error| format!("{error:?}"))?;

        let programs = plan
            .transaction
            .instructions
            .iter()
            .map(|instruction| Address::new_from_array(instruction.program.0))
            .collect();

        Ok(Sent { plan, programs })
    }

    /// The refusal code when the builder refuses the transfer.
    pub fn refusal(&self, mint: &Address, amount: u64, memo: Option<&str>) -> Result<String, String> {
        match prepare(&self.svm, &self.documents(mint, amount, memo)?) {
            Err(PlanError::Refused { code, .. }) => Ok(code),
            Err(error) => Err(format!("{error:?}")),
            Ok(_) => Err("the builder did not refuse".into()),
        }
    }
}

impl MintExtension {
    fn kind(self) -> ExtensionType {
        match self {
            Self::TransferFee { .. } => ExtensionType::TransferFeeConfig,
            Self::TransferHook(_) => ExtensionType::TransferHook,
            Self::PermanentDelegate => ExtensionType::PermanentDelegate,
            Self::NonTransferable => ExtensionType::NonTransferable,
            Self::Pausable => ExtensionType::Pausable,
            Self::FrozenByDefault => ExtensionType::DefaultAccountState,
            Self::InterestBearing => ExtensionType::InterestBearingConfig,
        }
    }

    fn initialize(self, mint: &Address, authority: &Address) -> Result<Instruction, String> {
        let instruction = match self {
            Self::TransferFee { basis_points, maximum_fee } => {
                transfer_fee::instruction::initialize_transfer_fee_config(
                    &TOKEN_2022,
                    mint,
                    Some(authority),
                    Some(authority),
                    basis_points,
                    maximum_fee,
                )
            }
            Self::TransferHook(program) => {
                transfer_hook::instruction::initialize(&TOKEN_2022, mint, Some(*authority), program)
            }
            Self::PermanentDelegate => token_instruction::initialize_permanent_delegate(&TOKEN_2022, mint, authority),
            Self::NonTransferable => token_instruction::initialize_non_transferable_mint(&TOKEN_2022, mint),
            Self::Pausable => pausable::instruction::initialize(&TOKEN_2022, mint, authority),
            Self::FrozenByDefault => default_account_state::instruction::initialize_default_account_state(
                &TOKEN_2022,
                mint,
                &AccountState::Frozen,
            ),
            Self::InterestBearing => {
                interest_bearing_mint::instruction::initialize(&TOKEN_2022, mint, Some(*authority), 500)
            }
        };

        instruction.map_err(|error| format!("{error:?}"))
    }
}

pub fn ata(owner: &Address, mint: &Address) -> Address {
    let (address, _) =
        Address::find_program_address(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &ASSOCIATED_TOKEN);

    address
}

pub fn create_ata(payer: &Address, owner: &Address, mint: &Address) -> Instruction {
    Instruction {
        program_id: ASSOCIATED_TOKEN,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ],
        data: vec![1],
    }
}

fn create_account(payer: &Address, account: &Address, lamports: u64, space: usize) -> Instruction {
    let space = u64::try_from(space).unwrap_or(u64::MAX);
    let data = [&0u32.to_le_bytes()[..], &lamports.to_le_bytes(), &space.to_le_bytes(), TOKEN_2022.as_ref()].concat();

    Instruction {
        program_id: SYSTEM,
        accounts: vec![AccountMeta::new(*payer, true), AccountMeta::new(*account, true)],
        data,
    }
}
