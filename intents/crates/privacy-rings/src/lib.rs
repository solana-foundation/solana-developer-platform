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
use spr_client::fetch_asset_id;
use spr_client::prover::known_proving_keys;
use spr_client::user_registry::{register_if_absent, resolve_registered_address, StrictRegistration};
use spr_client::{
    compile_message, sign_transaction, ComputeBudgetConfig, ProverClient, Rpc as _, SignedPrivateTransaction,
    SolanaRpc, Submission, UnsignedMessage, UtxoScan, ZolanaClient, ZolanaIndexer,
};
use spr_interface::pda;
use spr_keypair::{ShieldedKeypair, SigningKey};
use spr_program::instruction::{
    AssetDeposit, CreateSplInterface, Deposit, DepositAsset, DepositSplAccounts, TransactInterfaceTransferAccounts,
    TransactSolTransferAccounts, TransactSplDepositAccounts,
};
use spr_transaction::instructions::transact::ConfidentialTransaction;
use spr_transaction::{select_spend, AssetRegistry, Mint, SpendableDecryptionResult, SOL_MINT};

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

/// What a spend does (`DESIGN.md`, 4.17).
#[derive(Clone, Debug, Default)]
pub struct Statement {
    pub notes: Vec<NoteOut>,
    pub deposits: Vec<Leg>,
    pub withdrawals: Vec<Leg>,
}

impl Statement {
    /// For each asset, what the spend takes from the spender's notes: the notes that it creates
    /// plus its withdrawals, less its deposits. A deposit above that comes back as change.
    pub fn consumed(&self) -> Result<BTreeMap<Address, u64>, ShieldedError> {
        let created: Vec<Amount> =
            self.notes.iter().map(|note| note.value).chain(self.withdrawals.iter().map(|leg| leg.value)).collect();
        let deposited = totals(&self.deposits.iter().map(|leg| leg.value).collect::<Vec<_>>())?;

        Ok(totals(&created)?
            .into_iter()
            .filter_map(|(asset, amount)| {
                let funded = deposited.get(&asset).copied().unwrap_or_default();

                amount.checked_sub(funded).filter(|left| *left > 0).map(|left| (asset, left))
            })
            .collect())
    }
}

/// The proving keys of the default ring's confidential transfers, which every spend here proves
/// with. Their names start with this.
const CONFIDENTIAL_KEYS: &str = "transfer_confidential_";

/// The SHA-256 of the confidential transfer keys that this client holds: each key's name, a zero
/// byte, and the key's SHA-256, sorted by name. A shielded recipe's circuit pins it. Keys of other
/// circuits, such as merges and the forester's, can change without changing it.
pub fn proving_key_set() -> [u8; 32] {
    let mut keys: Vec<(&str, [u8; 32])> =
        known_proving_keys().filter(|(name, _)| name.starts_with(CONFIDENTIAL_KEYS)).collect();
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

    /// Creates the pool's SPL interface for `mint`, which holds the mint's shielded tokens, when it
    /// has none. Only a protocol that allows it lets any signer create one, as the localnet does.
    pub fn register_asset(&self, payer: &Keypair, mint: Address) -> Result<(), ShieldedError> {
        if fetch_asset_id(self.client.rpc(), mint).is_ok() {
            return Ok(());
        }

        let instruction =
            CreateSplInterface { authority: payer.pubkey(), mint, token_program: self.token_program(mint)? }
                .instruction();
        let (blockhash, _) =
            self.client.rpc().get_latest_blockhash().map_err(|cause| error("read a blockhash")(&cause))?;
        let message =
            compile_message(&payer.pubkey(), &[instruction], blockhash, ComputeBudgetConfig::for_instruction_count(1))
                .map_err(|cause| error("SPL interface message")(&cause))?;
        let transaction = sign_transaction(message, &[payer]).map_err(|cause| error("sign")(&cause))?;

        self.client
            .rpc()
            .process_transaction(transaction)
            .map_err(|cause| error("create the SPL interface")(&cause))?;

        Ok(())
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
    /// spends notes. A statement whose deposits fund exactly its notes uses the pool's `deposit`,
    /// which has no proof. Every other statement is one `transact`.
    pub fn prepare(
        &self,
        wallet: &ShieldedWallet,
        fee_payer: Address,
        statement: &Statement,
        prover: &str,
    ) -> Result<PreparedSpend, ShieldedError> {
        let deposited = totals(&statement.deposits.iter().map(|leg| leg.value).collect::<Vec<_>>())?;
        let noted = totals(&statement.notes.iter().map(|note| note.value).collect::<Vec<_>>())?;

        match !statement.deposits.is_empty() && statement.withdrawals.is_empty() && deposited == noted {
            true => self.prepare_deposit(wallet, fee_payer, statement),
            false => self.prepare_transact(wallet, fee_payer, statement, prover),
        }
    }

    /// A deposit spends no note, so it needs no proof, and it is public. The wallet deposits from its
    /// own accounts only.
    fn prepare_deposit(
        &self,
        wallet: &ShieldedWallet,
        fee_payer: Address,
        statement: &Statement,
    ) -> Result<PreparedSpend, ShieldedError> {
        if statement.deposits.iter().any(|leg| leg.account != wallet.address()) {
            return Err(ShieldedError("a deposit comes from the spender's own accounts".to_owned()));
        }

        let deposits = statement
            .notes
            .iter()
            .map(|note| self.deposit_entry(note, wallet.address()))
            .collect::<Result<Vec<_>, _>>()?;
        let deposit = Deposit { tree: self.tree, depositor: wallet.address(), deposits }
            .instruction()
            .map_err(|cause| error("deposit instruction")(&cause))?;

        let (blockhash, last_valid_block_height) =
            self.client.rpc().get_latest_blockhash().map_err(|cause| error("read a blockhash")(&cause))?;
        let message = compile_message(&fee_payer, &[deposit], blockhash, ComputeBudgetConfig::for_instruction_count(1))
            .map_err(|cause| error("deposit message")(&cause))?;

        Ok(PreparedSpend { message: UnsignedMessage { message, last_valid_block_height }, nullifiers: Vec::new() })
    }

    fn deposit_entry(&self, note: &NoteOut, depositor: Address) -> Result<AssetDeposit, ShieldedError> {
        let recipient = resolve_registered_address(self.client.rpc(), note.owner)
            .map_err(|cause| error("resolve the owner's record")(&cause))?;
        let owner = recipient.address.owner_hash().map_err(|cause| error("owner hash")(&cause))?;
        let asset = match note.value.asset == SOL_MINT {
            true => DepositAsset::Sol,
            false => {
                let mint = note.value.asset;
                let token_program = self.token_program(mint)?;
                let user_token = pda::associated_token_address_with_program(&depositor, &mint, &token_program);

                DepositAsset::Spl(DepositSplAccounts { mint, user_token, token_program })
            }
        };

        Ok(AssetDeposit {
            asset,
            view_tag: recipient.address.viewing_pubkey.u(),
            owner,
            amount: note.value.amount,
            memo: None,
        })
    }

    /// The token program that owns `mint`: Token or Token-2022.
    fn token_program(&self, mint: Address) -> Result<Address, ShieldedError> {
        let account = self.client.rpc().get_account(mint).map_err(|cause| error("read the mint")(&cause))?;

        account.map(|account| account.owner).ok_or_else(|| ShieldedError(format!("the mint {mint} does not exist")))
    }

    /// The asset with the id that the pool registered for it. An SPL mint needs its SPL interface.
    fn mint(&self, asset: Address) -> Result<Mint, ShieldedError> {
        let asset_id = fetch_asset_id(self.client.rpc(), asset).map_err(|cause| error("the asset's id")(&cause))?;

        Ok(Mint::new(asset, asset_id))
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

    /// The wallet's private balance of SOL and of each of `assets` that it holds, from its unspent
    /// notes.
    pub fn balances(&self, wallet: &ShieldedWallet, assets: &[Address]) -> Result<Vec<Amount>, ShieldedError> {
        let spendable = self.spendable(wallet, assets)?;

        Ok(spendable
            .balances
            .assets
            .iter()
            .map(|balance| Amount { asset: balance.mint, amount: balance.amount })
            .collect())
    }

    /// The wallet's private balance of `asset`, from its unspent notes.
    pub fn balance(&self, wallet: &ShieldedWallet, asset: Address) -> Result<u64, ShieldedError> {
        let spendable = self.spendable(wallet, &[asset])?;

        Ok(spendable.balances.get_balance(asset).map_or(0, |balance| balance.amount))
    }

    /// One `transact`: the wallet's notes that cover the statement go in, then its deposits, its
    /// notes, its withdrawals, and the change. The settlement accounts follow the order of the
    /// deposits and withdrawals. The SDK verifies the proof against the pool's verifying key, and
    /// checks the SHA-256 of the key that the prover used.
    fn prepare_transact(
        &self,
        wallet: &ShieldedWallet,
        fee_payer: Address,
        statement: &Statement,
        prover: &str,
    ) -> Result<PreparedSpend, ShieldedError> {
        let consumed = statement.consumed()?;
        let spendable = self.spendable(wallet, &consumed.keys().copied().collect::<Vec<_>>())?;
        let inputs = consumed
            .into_iter()
            .map(|(asset, amount)| select_spend(spendable.utxos(), asset, amount))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|cause| error("select notes")(&cause))?
            .concat();
        let nullifiers = inputs.iter().map(|input| input.nullifier).collect();
        let mut transaction =
            ConfidentialTransaction::new(inputs, fee_payer).map_err(|cause| error("transaction")(&cause))?;

        let deposits = statement
            .deposits
            .iter()
            .map(|leg| self.add_deposit(&mut transaction, leg))
            .collect::<Result<Vec<_>, _>>()?;

        for note in &statement.notes {
            let recipient = resolve_registered_address(self.client.rpc(), note.owner)
                .map_err(|cause| error("resolve the owner's record")(&cause))?;
            transaction
                .transfer_with_ring(&recipient.address, self.mint(note.value.asset)?, note.value.amount, None)
                .map_err(|cause| error("note")(&cause))?;
        }

        let withdrawals = statement
            .withdrawals
            .iter()
            .map(|leg| {
                let token_program =
                    (leg.value.asset != SOL_MINT).then(|| self.token_program(leg.value.asset)).transpose()?;

                transaction
                    .withdraw_to(leg.value.asset, leg.value.amount, leg.account, token_program)
                    .map_err(|cause| error("withdrawal")(&cause))
            })
            .collect::<Result<Vec<_>, _>>()?;

        let signed = SignedPrivateTransaction {
            transaction: transaction.encrypt(&wallet.keypair).map_err(|cause| error("encrypt")(&cause))?,
            settlement_transfers: deposits.into_iter().chain(withdrawals).collect(),
        };
        let message = Submission::new(&signed, fee_payer, &wallet.keypair)
            .with_prover(Arc::new(ProverClient::new(prover.to_owned())))
            .finish_unsigned_sync(&self.client)
            .map_err(|cause| error("prove")(&cause))?;

        Ok(PreparedSpend { message, nullifiers })
    }

    /// A public amount into the spend from the spender's own account, and its settlement accounts.
    fn add_deposit(
        &self,
        transaction: &mut ConfidentialTransaction,
        leg: &Leg,
    ) -> Result<TransactInterfaceTransferAccounts, ShieldedError> {
        let deposit = |cause: &dyn core::fmt::Display| error("deposit")(cause);

        if leg.value.asset == SOL_MINT {
            transaction.deposit_sol(leg.value.amount, leg.account).map_err(|cause| deposit(&cause))?;

            return Ok(TransactInterfaceTransferAccounts::Sol(TransactSolTransferAccounts { recipient: leg.account }));
        }

        let mint = leg.value.asset;
        let token_program = self.token_program(mint)?;
        let user_token_account = pda::associated_token_address_with_program(&leg.account, &mint, &token_program);
        transaction.deposit(self.mint(mint)?, leg.value.amount, user_token_account).map_err(|cause| deposit(&cause))?;

        Ok(TransactInterfaceTransferAccounts::SplDeposit(TransactSplDepositAccounts {
            mint,
            spl_interface: pda::spl_interface(&mint),
            token_authority: leg.account,
            user_token_account,
            token_program,
        }))
    }

    /// The wallet's unspent notes of SOL and of `assets`, decrypted from what the indexer holds for
    /// its tags. Each SPL asset's id comes from its registry account in the pool, so the scan needs
    /// no search of the pool's accounts. A note of another asset is left out.
    fn spendable(
        &self,
        wallet: &ShieldedWallet,
        assets: &[Address],
    ) -> Result<SpendableDecryptionResult, ShieldedError> {
        let known = assets
            .iter()
            .filter(|asset| **asset != SOL_MINT)
            .map(|asset| self.mint(*asset).map(|mint| (mint.asset_id, mint.asset)))
            .collect::<Result<Vec<_>, _>>()?;
        let registry = AssetRegistry::new(known).map_err(|cause| error("the assets")(&cause))?;
        let scan = UtxoScan::new(&wallet.keypair, &registry)
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
    const DEFINITIONS_KEY_SET: &str = "affddbe0260740233c15f3f9545b1f873f99035d2f6dc55233e70f3a06b90d80";

    #[test]
    fn the_definitions_pin_this_key_set() {
        let digest: String = proving_key_set().iter().map(|byte| format!("{byte:02x}")).collect();

        assert_eq!(digest, DEFINITIONS_KEY_SET);
    }
}
