//! Private spends through Solana Privacy Rings by Helius, for the `shielded` recipe kind
//! (`packages/sdp-intents/DESIGN.md`, 4.17).
//!
//! A shielded spend consumes the wallet's notes and creates new ones. Building one needs the
//! wallet's shielded keys, its notes from the Photon indexer, and a proof from the prover. The
//! result is an unsigned v1 message of one pool instruction, which the wallet's Solana key and the
//! fee payer sign. This is the confidential rail: amounts and recipients are hidden, and the
//! signers are public.

use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer as _;
use spr_client::user_registry::{register_if_absent, resolve_registered_address, StrictRegistration};
use spr_client::{
    compile_message, sign_transaction, ComputeBudgetConfig, ProverClient, Rpc as _, SignedPrivateTransaction,
    SolanaRpc, Submission, UnsignedMessage, UtxoScan, ZolanaClient, ZolanaIndexer,
};
use spr_keypair::{ShieldedKeypair, SigningKey};
use spr_program::instruction::{AssetDeposit, Deposit, DepositAsset};
use spr_transaction::instructions::transact::ConfidentialTransaction;
use spr_transaction::{select_spend, AssetRegistry, SpendableDecryptionResult, SOL_MINT};

/// The services that a shielded spend reads, and the pool tree that new notes go into.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub rpc: String,
    pub indexer: String,
    pub prover: String,
    pub tree: Address,
}

/// A wallet's Solana key and the shielded keys that derive from the same seed.
pub struct ShieldedWallet {
    funding: Keypair,
    keypair: ShieldedKeypair,
}

/// What the wallet's Solana key signs to send a shielded spend, and the nullifiers of the notes
/// that it consumes. A deposit consumes none.
pub struct PreparedSpend {
    pub message: UnsignedMessage,
    pub nullifiers: Vec<[u8; 32]>,
}

/// The Privacy Rings pool program, which every spend calls.
pub fn pool_program() -> Address {
    spr_interface::pda::shielded_pool_program_id()
}

/// The pool creates one account for each nullifier that a spend consumes, under the tree of the
/// spent note. A forester closes them later, so a missing one proves nothing.
pub fn nullifier_accounts(spend: &PreparedSpend) -> Vec<Address> {
    let keys = spend.message.message.static_account_keys();

    spend
        .nullifiers
        .iter()
        .filter_map(|nullifier| {
            keys.iter()
                .map(|tree| spr_interface::pda::nullifier_pda(tree, nullifier).0)
                .find(|derived| keys.contains(derived))
        })
        .collect()
}

impl PreparedSpend {
    /// The message in its wire form, which the signers sign.
    pub fn message_bytes(&self) -> Vec<u8> {
        self.message.message.serialize()
    }

    pub fn last_valid_block_height(&self) -> u64 {
        self.message.last_valid_block_height
    }
}

/// An amount of one asset.
#[derive(Clone, Copy, Debug)]
pub struct Amount {
    pub asset: Address,
    pub amount: u64,
}

#[derive(Debug)]
pub struct ShieldedError(String);

impl core::fmt::Display for ShieldedError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ShieldedError {}

fn error(context: &str) -> impl Fn(&dyn core::fmt::Display) -> ShieldedError + '_ {
    move |cause| ShieldedError(format!("{context}: {cause}"))
}

impl ShieldedWallet {
    /// The Solana key and the shielded keys of one Ed25519 seed. Privacy Rings requires both from the same
    /// seed for an Ed25519 wallet.
    pub fn from_seed(seed: &[u8; 32]) -> Result<Self, ShieldedError> {
        let keypair = ShieldedKeypair::from_keypair(SigningKey::from_ed25519_bytes(seed))
            .map_err(|cause| error("shielded keys")(&cause))?;

        Ok(Self { funding: Keypair::new_from_array(*seed), keypair })
    }

    pub fn address(&self) -> Address {
        self.funding.pubkey()
    }

    pub fn funding(&self) -> &Keypair {
        &self.funding
    }
}

/// A connection to a privacy ring's RPC, indexer, and prover.
pub struct Shielded {
    client: ZolanaClient<SolanaRpc>,
    indexer: ZolanaIndexer,
    tree: Address,
}

impl Shielded {
    pub fn connect(endpoints: &Endpoints) -> Self {
        let client = ZolanaClient::new(
            SolanaRpc::new(endpoints.rpc.clone()),
            ZolanaIndexer::new(&endpoints.indexer),
            ProverClient::new(endpoints.prover.clone()),
        );

        Self { client, indexer: ZolanaIndexer::new(&endpoints.indexer), tree: endpoints.tree }
    }

    /// Writes the wallet's registry record, which maps its Solana address to its shielded address,
    /// when it has none. A sender that knows only the Solana address finds the recipient here.
    pub fn register(&self, wallet: &ShieldedWallet) -> Result<(), ShieldedError> {
        match register_if_absent(self.client.rpc(), &wallet.funding, &wallet.keypair)
            .map_err(|cause| error("register")(&cause))?
        {
            StrictRegistration::Written(_) | StrictRegistration::Current => Ok(()),
            _ => Err(ShieldedError("the registry holds other shielded keys for this wallet".to_owned())),
        }
    }

    /// Moves `lamports` of the wallet's public SOL into a note of its own, and sends it.
    pub fn shield_sol(&self, wallet: &ShieldedWallet, lamports: u64) -> Result<(), ShieldedError> {
        let prepared = self.prepare_deposit(wallet, wallet.address(), SOL_MINT, lamports)?;
        let transaction = sign_transaction(prepared.message.message, &[&wallet.funding])
            .map_err(|cause| error("sign the deposit")(&cause))?;

        self.client.rpc().process_transaction(transaction).map_err(|cause| error("send the deposit")(&cause))?;

        Ok(())
    }

    /// A deposit of `amount` of the wallet's public `asset` into a note of its own, for its Solana
    /// key to sign. A deposit spends no note, so it needs no proof, and it is public. Only SOL is
    /// supported so far.
    pub fn prepare_deposit(
        &self,
        wallet: &ShieldedWallet,
        fee_payer: Address,
        asset: Address,
        amount: u64,
    ) -> Result<PreparedSpend, ShieldedError> {
        if asset != SOL_MINT {
            return Err(ShieldedError("only SOL deposits into the ring so far".to_owned()));
        }

        let recipient = resolve_registered_address(self.client.rpc(), wallet.address())
            .map_err(|cause| error("resolve the wallet's record")(&cause))?;
        let owner = recipient.address.owner_hash().map_err(|cause| error("owner hash")(&cause))?;
        let deposit = Deposit {
            tree: self.tree,
            depositor: wallet.address(),
            deposits: vec![AssetDeposit {
                asset: DepositAsset::Sol,
                view_tag: recipient.address.viewing_pubkey.u(),
                owner,
                amount,
                memo: None,
            }],
        }
        .instruction()
        .map_err(|cause| error("deposit instruction")(&cause))?;

        let (blockhash, last_valid_block_height) =
            self.client.rpc().get_latest_blockhash().map_err(|cause| error("read a blockhash")(&cause))?;
        let message = compile_message(&fee_payer, &[deposit], blockhash, ComputeBudgetConfig::for_instruction_count(1))
            .map_err(|cause| error("deposit message")(&cause))?;

        Ok(PreparedSpend { message: UnsignedMessage { message, last_valid_block_height }, nullifiers: Vec::new() })
    }

    /// Waits until the wallet's private balance of `amount.asset` reaches `amount.amount`, such as
    /// after a deposit that the indexer has not read yet.
    pub fn await_balance(
        &self,
        wallet: &ShieldedWallet,
        amount: Amount,
        timeout: std::time::Duration,
    ) -> Result<(), ShieldedError> {
        let deadline = std::time::Instant::now().checked_add(timeout);

        loop {
            let balance = self.balance(wallet, amount.asset)?;
            let expired = deadline.is_none_or(|deadline| std::time::Instant::now() >= deadline);

            match (balance >= amount.amount, expired) {
                (true, _) => return Ok(()),
                (false, true) => {
                    return Err(ShieldedError(format!(
                        "the private balance is {balance}, short of {}, after {} seconds",
                        amount.amount,
                        timeout.as_secs()
                    )))
                }
                (false, false) => std::thread::sleep(std::time::Duration::from_secs(1)),
            }
        }
    }

    /// The wallet's private balance of `asset`, from its unspent notes.
    pub fn balance(&self, wallet: &ShieldedWallet, asset: Address) -> Result<u64, ShieldedError> {
        let spendable = self.spendable(wallet)?;

        Ok(spendable.balances.get_balance(asset).map_or(0, |balance| balance.amount))
    }

    /// A private transfer of `amount` of `asset` to the wallet registered for `to`. Returns the
    /// unsigned message, with the proof inside, for the sender's Solana key and the fee payer to sign.
    pub fn prepare_transfer(
        &self,
        wallet: &ShieldedWallet,
        fee_payer: Address,
        to: Address,
        transfer: Amount,
    ) -> Result<PreparedSpend, ShieldedError> {
        let Amount { asset, amount } = transfer;
        let spendable = self.spendable(wallet)?;
        let inputs = select_spend(spendable.utxos(), asset, amount).map_err(|cause| error("select notes")(&cause))?;
        let nullifiers = inputs.iter().map(|input| input.nullifier).collect();
        let recipient = resolve_registered_address(self.client.rpc(), to)
            .map_err(|cause| error("resolve the recipient's record")(&cause))?;

        let mut transaction =
            ConfidentialTransaction::new(inputs, fee_payer).map_err(|cause| error("transaction")(&cause))?;
        let outputs = match asset == SOL_MINT {
            true => transaction.transfer_sol(&recipient.address, amount),
            false => transaction.transfer(&recipient.address, asset, amount),
        };
        outputs.map_err(|cause| error("transfer output")(&cause))?;

        let signed = SignedPrivateTransaction {
            transaction: transaction.encrypt(&wallet.keypair).map_err(|cause| error("encrypt")(&cause))?,
            settlement_transfers: Vec::new(),
        };
        let message = Submission::new(&signed, fee_payer, &wallet.keypair)
            .finish_unsigned_sync(&self.client)
            .map_err(|cause| error("prove")(&cause))?;

        Ok(PreparedSpend { message, nullifiers })
    }

    /// The wallet's unspent notes, decrypted from what the indexer holds for its tags.
    fn spendable(&self, wallet: &ShieldedWallet) -> Result<SpendableDecryptionResult, ShieldedError> {
        let assets = AssetRegistry::default();
        let scan = UtxoScan::new(&wallet.keypair, &assets)
            .with_asset_discovery()
            .fetch(&self.indexer)
            .map_err(|cause| error("scan the wallet's notes")(&cause))?;

        Ok(scan.spendable)
    }

    pub fn client(&self) -> &ZolanaClient<SolanaRpc> {
        &self.client
    }
}
