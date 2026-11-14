//! Private spends through Helius privacy rings (Zolana), for the `shielded` recipe kind
//! (`packages/sdp-intents/DESIGN.md`, 4.17).
//!
//! A shielded spend consumes the wallet's notes and creates new ones. Building one needs the
//! wallet's shielded keys, its notes from the Photon indexer, and a proof from the prover. The
//! result is an unsigned v1 message that the wallet's Solana key signs as fee payer, which is the
//! confidential rail: amounts and recipients are hidden, and the fee payer is public.

use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer as _;
use spr_client::user_registry::{register_if_absent, resolve_registered_address, StrictRegistration};
use spr_client::{
    ComputeBudgetConfig, ProverClient, Rpc as _, SignedPrivateTransaction, SolanaRpc, Submission, UnsignedMessage,
    UtxoScan, ZolanaClient, ZolanaIndexer,
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

/// What the wallet's Solana key signs to send a shielded spend.
pub struct PreparedSpend {
    pub message: UnsignedMessage,
}

impl PreparedSpend {
    /// The message in its wire form, which the signers sign.
    pub fn message_bytes(&self) -> Vec<u8> {
        self.message.message.serialize()
    }
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
    /// The Solana key and the shielded keys of one Ed25519 seed. Zolana requires both from the same
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

    /// Moves `lamports` of the wallet's public SOL into a note of its own. A deposit spends no note,
    /// so it needs no proof, and it is public.
    pub fn shield_sol(&self, wallet: &ShieldedWallet, lamports: u64) -> Result<(), ShieldedError> {
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
                amount: lamports,
                memo: None,
            }],
        }
        .instruction()
        .map_err(|cause| error("deposit instruction")(&cause))?;

        self.client
            .rpc()
            .create_and_send_transaction(
                &[deposit],
                wallet.address(),
                &[&wallet.funding],
                ComputeBudgetConfig::for_instruction_count(1),
            )
            .map_err(|cause| error("send the deposit")(&cause))?;

        Ok(())
    }

    /// The wallet's private balance of `asset`, from its unspent notes.
    pub fn balance(&self, wallet: &ShieldedWallet, asset: Address) -> Result<u64, ShieldedError> {
        let spendable = self.spendable(wallet)?;

        Ok(spendable.balances.get_balance(asset).map_or(0, |balance| balance.amount))
    }

    /// A private transfer of `amount` of `asset` to the wallet registered for `to`. Returns the
    /// unsigned message, with the proof inside, for the sender's Solana key to sign.
    pub fn prepare_transfer(
        &self,
        wallet: &ShieldedWallet,
        to: Address,
        asset: Address,
        amount: u64,
    ) -> Result<PreparedSpend, ShieldedError> {
        let spendable = self.spendable(wallet)?;
        let inputs = select_spend(spendable.utxos(), asset, amount).map_err(|cause| error("select notes")(&cause))?;
        let recipient = resolve_registered_address(self.client.rpc(), to)
            .map_err(|cause| error("resolve the recipient's record")(&cause))?;

        let mut transaction =
            ConfidentialTransaction::new(inputs, wallet.address()).map_err(|cause| error("transaction")(&cause))?;
        let outputs = match asset == SOL_MINT {
            true => transaction.transfer_sol(&recipient.address, amount),
            false => transaction.transfer(&recipient.address, asset, amount),
        };
        outputs.map_err(|cause| error("transfer output")(&cause))?;

        let signed = SignedPrivateTransaction {
            transaction: transaction.encrypt(&wallet.keypair).map_err(|cause| error("encrypt")(&cause))?,
            settlement_transfers: Vec::new(),
        };
        let message = Submission::new(&signed, wallet.address(), &wallet.keypair)
            .finish_unsigned_sync(&self.client)
            .map_err(|cause| error("prove")(&cause))?;

        Ok(PreparedSpend { message })
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
