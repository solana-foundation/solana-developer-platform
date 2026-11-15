//! Private spends through Solana Privacy Rings by Helius, for the `shielded` recipe kind
//! (`packages/sdp-intents/DESIGN.md`, 4.17).
//!
//! A spend's statement names the notes that it creates and the public amounts that it deposits and
//! withdraws. [`Shielded::prepare`] builds any statement: it picks the wallet's notes that cover it,
//! proves it through the prover that the caller names, and verifies the proof. The result is an
//! unsigned v1 message of one pool instruction, which the wallet's Solana key and the fee payer
//! sign. This is the confidential rail: amounts and recipients are hidden, and the signers are
//! public.

use std::collections::BTreeMap;
use std::sync::Arc;

use sha2::{Digest as _, Sha256};
use solana_address::Address;
use solana_keypair::Keypair;
use solana_signer::Signer as _;
use spr_client::prover::known_proving_keys;
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

/// A note that a spend creates, for the wallet that the registry maps `owner` to.
#[derive(Clone, Copy, Debug)]
pub struct NoteOut {
    pub owner: Address,
    pub value: Amount,
}

/// A public amount that a spend deposits from `account` or withdraws to it.
#[derive(Clone, Copy, Debug)]
pub struct Leg {
    pub account: Address,
    pub value: Amount,
}

/// What a spend does (`DESIGN.md`, 4.17). It consumes, for each asset, the notes that it creates
/// plus its withdrawals, less its deposits, from the spender's notes.
#[derive(Clone, Debug, Default)]
pub struct Statement {
    pub notes: Vec<NoteOut>,
    pub deposits: Vec<Leg>,
    pub withdrawals: Vec<Leg>,
}

/// The SHA-256 of the proving key set that this client holds: each key's name, a zero byte, and the
/// key's SHA-256, sorted by name. A shielded recipe pins it as its `circuit`.
pub fn proving_key_set() -> [u8; 32] {
    let mut keys: Vec<(&str, [u8; 32])> = known_proving_keys().collect();
    keys.sort_unstable_by_key(|(name, _)| *name);

    keys.iter()
        .fold(Sha256::new(), |hasher, (name, sha256)| {
            hasher.chain_update(name.as_bytes()).chain_update([0]).chain_update(sha256)
        })
        .finalize()
        .into()
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
        let value = Amount { asset: SOL_MINT, amount: lamports };
        let statement = Statement {
            notes: vec![NoteOut { owner: wallet.address(), value }],
            deposits: vec![Leg { account: wallet.address(), value }],
            withdrawals: Vec::new(),
        };
        let prepared = self.prepare_deposit(wallet, wallet.address(), &statement)?;
        let transaction = sign_transaction(prepared.message.message, &[&wallet.funding])
            .map_err(|cause| error("sign the deposit")(&cause))?;

        self.client.rpc().process_transaction(transaction).map_err(|cause| error("send the deposit")(&cause))?;

        Ok(())
    }

    /// Builds `statement` for the wallet's Solana key to sign, and proves it through `prover` when it
    /// spends notes. A statement that deposits uses the pool's `deposit`, which has no proof.
    pub fn prepare(
        &self,
        wallet: &ShieldedWallet,
        fee_payer: Address,
        statement: &Statement,
        prover: &str,
    ) -> Result<PreparedSpend, ShieldedError> {
        match statement.deposits.is_empty() {
            true => self.prepare_transact(wallet, fee_payer, statement, prover),
            false => self.prepare_deposit(wallet, fee_payer, statement),
        }
    }

    /// Each deposit must come from the wallet, and the notes must take exactly what it deposits,
    /// because a deposit spends no note. Only SOL is supported so far.
    fn prepare_deposit(
        &self,
        wallet: &ShieldedWallet,
        fee_payer: Address,
        statement: &Statement,
    ) -> Result<PreparedSpend, ShieldedError> {
        let from_wallet = statement.deposits.iter().all(|leg| leg.account == wallet.address());
        let sol_only = statement
            .deposits
            .iter()
            .map(|leg| leg.value)
            .chain(statement.notes.iter().map(|note| note.value))
            .all(|value| value.asset == SOL_MINT);

        if !statement.withdrawals.is_empty() || !from_wallet || !sol_only {
            return Err(ShieldedError(
                "a deposit here comes from the wallet, in SOL, and withdraws nothing".to_owned(),
            ));
        }

        if totals(&statement.deposits.iter().map(|leg| leg.value).collect::<Vec<_>>())?
            != totals(&statement.notes.iter().map(|note| note.value).collect::<Vec<_>>())?
        {
            return Err(ShieldedError("a spend that deposits and also consumes notes is not built".to_owned()));
        }

        let deposits = statement.notes.iter().map(|note| self.deposit_entry(note)).collect::<Result<Vec<_>, _>>()?;
        let deposit = Deposit { tree: self.tree, depositor: wallet.address(), deposits }
            .instruction()
            .map_err(|cause| error("deposit instruction")(&cause))?;

        let (blockhash, last_valid_block_height) =
            self.client.rpc().get_latest_blockhash().map_err(|cause| error("read a blockhash")(&cause))?;
        let message = compile_message(&fee_payer, &[deposit], blockhash, ComputeBudgetConfig::for_instruction_count(1))
            .map_err(|cause| error("deposit message")(&cause))?;

        Ok(PreparedSpend { message: UnsignedMessage { message, last_valid_block_height }, nullifiers: Vec::new() })
    }

    fn deposit_entry(&self, note: &NoteOut) -> Result<AssetDeposit, ShieldedError> {
        let recipient = resolve_registered_address(self.client.rpc(), note.owner)
            .map_err(|cause| error("resolve the owner's record")(&cause))?;
        let owner = recipient.address.owner_hash().map_err(|cause| error("owner hash")(&cause))?;

        Ok(AssetDeposit {
            asset: DepositAsset::Sol,
            view_tag: recipient.address.viewing_pubkey.u(),
            owner,
            amount: note.value.amount,
            memo: None,
        })
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

    /// One `transact`: the wallet's notes that cover the statement go in, and its notes, its
    /// withdrawals, and the change come out. The SDK verifies the proof against the pool's verifying
    /// key, and checks the SHA-256 of the key that the prover used.
    fn prepare_transact(
        &self,
        wallet: &ShieldedWallet,
        fee_payer: Address,
        statement: &Statement,
        prover: &str,
    ) -> Result<PreparedSpend, ShieldedError> {
        let consumed: Vec<Amount> = statement
            .notes
            .iter()
            .map(|note| note.value)
            .chain(statement.withdrawals.iter().map(|leg| leg.value))
            .collect();
        let spendable = self.spendable(wallet)?;
        let inputs = totals(&consumed)?
            .into_iter()
            .map(|(asset, amount)| select_spend(spendable.utxos(), asset, amount))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|cause| error("select notes")(&cause))?
            .concat();
        let nullifiers = inputs.iter().map(|input| input.nullifier).collect();

        let mut transaction =
            ConfidentialTransaction::new(inputs, fee_payer).map_err(|cause| error("transaction")(&cause))?;
        for note in &statement.notes {
            let recipient = resolve_registered_address(self.client.rpc(), note.owner)
                .map_err(|cause| error("resolve the owner's record")(&cause))?;
            let added = match note.value.asset == SOL_MINT {
                true => transaction.transfer_sol(&recipient.address, note.value.amount),
                false => transaction.transfer(&recipient.address, note.value.asset, note.value.amount),
            };
            added.map_err(|cause| error("note")(&cause))?;
        }

        let settlement_transfers = statement
            .withdrawals
            .iter()
            .map(|leg| match leg.value.asset == SOL_MINT {
                true => transaction
                    .withdraw_to(SOL_MINT, leg.value.amount, leg.account, None)
                    .map_err(|cause| error("withdrawal")(&cause)),
                false => Err(ShieldedError("only SOL withdrawals so far".to_owned())),
            })
            .collect::<Result<Vec<_>, _>>()?;

        let signed = SignedPrivateTransaction {
            transaction: transaction.encrypt(&wallet.keypair).map_err(|cause| error("encrypt")(&cause))?,
            settlement_transfers,
        };
        let message = Submission::new(&signed, fee_payer, &wallet.keypair)
            .with_prover(Arc::new(ProverClient::new(prover.to_owned())))
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

/// The sum of each asset's amounts.
fn totals(values: &[Amount]) -> Result<BTreeMap<Address, u64>, ShieldedError> {
    values.iter().try_fold(BTreeMap::new(), |mut totals, value| {
        let total: &mut u64 = totals.entry(value.asset).or_default();
        *total = total.checked_add(value.amount).ok_or_else(|| ShieldedError("an amount overflows".to_owned()))?;

        Ok(totals)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `circuit` that `intents/definitions` pins for Privacy Rings. A new key set changes it, and
    /// each shielded implementation then needs a new version.
    const DEFINITIONS_KEY_SET: &str = "fe926373458f17e60b017f36152e40748c3bf87ec24996176b8ba77015d03417";

    #[test]
    fn the_definitions_pin_this_key_set() {
        let digest: String = proving_key_set().iter().map(|byte| format!("{byte:02x}")).collect();

        assert_eq!(digest, DEFINITIONS_KEY_SET);
    }
}
