//! Simulates in process, in LiteSVM, over the cache. Each simulation writes every account that its
//! transaction names, as the cache holds it, then runs the v1 message that a signer would sign.
//! LiteSVM keeps each loaded program, and loads one again only when its bytes change.
//!
//! One LiteSVM serves every request, so simulations run one at a time. A simulation commits
//! nothing, and each one writes every account that it reads, so no state passes between requests.
//! The feature set is LiteSVM's, with every feature on, and can differ from the cluster's.

use std::collections::HashMap;
use std::hash::{BuildHasher, RandomState};
use std::sync::{Mutex, MutexGuard, PoisonError};

use litesvm::types::{FailedTransactionMetadata, SimulatedTransactionInfo};
use litesvm::LiteSVM;
use solana_account::{Account as SvmAccount, ReadableAccount as _};
use solana_sdk_ids::{bpf_loader, bpf_loader_deprecated, bpf_loader_upgradeable, native_loader, sysvar};
use solana_transaction::versioned::VersionedTransaction;

use sdp_intents_client::rpc;
use sdp_intents_planner::{Account, ReturnData, Simulation, SimulationResult};
use sdp_intents_spec::Address;

use crate::cache::Freshness;
use crate::{CachedRpc, ChainError};

/// The sysvars that LiteSVM holds. A missing one stays as LiteSVM holds it, because an empty account
/// at a sysvar address does not decode.
const SYSVARS: [solana_address::Address; 7] = [
    sysvar::clock::ID,
    sysvar::rent::ID,
    sysvar::epoch_schedule::ID,
    sysvar::slot_hashes::ID,
    sysvar::stake_history::ID,
    sysvar::epoch_rewards::ID,
    sysvar::last_restart_slot::ID,
];

/// An upgradeable program account is its 4-byte state tag, then the address of its program data.
const PROGRAM_DATA_ADDRESS: core::ops::Range<usize> = 4..36;

pub(crate) struct Simulator {
    state: Mutex<SimulatorState>,
}

struct SimulatorState {
    svm: LiteSVM,
    /// A fingerprint of the bytes of each program and program data account that LiteSVM holds.
    loaded: HashMap<Address, u64>,
    hasher: RandomState,
}

/// The accounts of one simulation, as the cache holds them.
struct Loaded {
    accounts: HashMap<Address, Option<Account>>,
    /// Program data accounts, which go in before the programs that read them.
    program_data: Vec<Address>,
}

impl Simulator {
    pub(crate) fn new() -> Self {
        let svm = LiteSVM::new().with_sigverify(false).with_blockhash_check(false);
        let state = SimulatorState { svm, loaded: HashMap::new(), hasher: RandomState::new() };

        Self { state: Mutex::new(state) }
    }

    fn state(&self) -> MutexGuard<'_, SimulatorState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl CachedRpc {
    /// Simulates in LiteSVM when the service runs one, and on the RPC otherwise.
    pub async fn simulate(&self, simulation: &Simulation) -> Result<SimulationResult, ChainError> {
        if self.inner.simulator.is_none() {
            return self.simulate_on_rpc(simulation).await;
        }

        let transaction = rpc::simulation_transaction(simulation)?;
        let loaded = self.load(simulation).await?;
        let inner = std::sync::Arc::clone(&self.inner);
        let observe = simulation.observe.clone();

        tokio::task::spawn_blocking(move || {
            let simulator = inner.simulator.as_ref().ok_or_else(|| ChainError::Decode("no simulator".into()))?;

            simulator.state().simulate(transaction, &loaded, &observe)
        })
        .await
        .map_err(|error| ChainError::Decode(format!("the simulation task failed: {error}")))?
    }

    /// Every account that the transaction names, the lookup tables of a fixed message, the observed
    /// accounts, and the clock, then the program data of each upgradeable program among them. Each
    /// program and program data account stays under a subscription, so a later simulation reads it
    /// from the cache.
    async fn load(&self, simulation: &Simulation) -> Result<Loaded, ChainError> {
        let tables = simulation.fixed.iter().flat_map(|fixed| fixed.lookup_tables.iter().copied());
        let clock = Address(sysvar::clock::ID.to_bytes());
        let mut addresses: Vec<Address> = simulation
            .transaction
            .accounts()
            .into_iter()
            .chain(tables)
            .chain(simulation.observe.iter().copied())
            .chain([clock])
            .collect();
        addresses.sort_unstable_by_key(|address| address.0);
        addresses.dedup();

        let fetched = self.accounts(&addresses, Freshness::Live).await?;
        let mut accounts: HashMap<Address, Option<Account>> = addresses.into_iter().zip(fetched).collect();

        let programs: Vec<Address> = accounts
            .iter()
            .filter_map(|(address, account)| account.as_ref().filter(|account| is_program(account)).map(|_| *address))
            .collect();
        let program_data: Vec<Address> = programs
            .iter()
            .filter_map(|program| accounts.get(program).cloned().flatten())
            .filter(|account| owned_by(account, &bpf_loader_upgradeable::ID))
            .filter_map(|account| account.data.get(PROGRAM_DATA_ADDRESS)?.try_into().ok().map(Address))
            .collect();

        let fetched = self.accounts(&program_data, Freshness::Live).await?;
        accounts.extend(program_data.iter().copied().zip(fetched));
        programs.iter().chain(&program_data).for_each(|address| self.subscribe(*address));

        Ok(Loaded { accounts, program_data })
    }
}

impl SimulatorState {
    fn simulate(
        &mut self,
        transaction: VersionedTransaction,
        loaded: &Loaded,
        observe: &[Address],
    ) -> Result<SimulationResult, ChainError> {
        for address in &loaded.program_data {
            if self.write(address, loaded.accounts.get(address).cloned().flatten())? {
                self.forget_programs_of(address, loaded);
            }
        }

        let others = loaded.accounts.iter().filter(|(address, _)| !loaded.program_data.contains(address));
        let (programs, plain): (Vec<_>, Vec<_>) =
            others.partition(|(_, account)| account.as_ref().is_some_and(is_program));

        for (address, account) in plain.into_iter().chain(programs) {
            self.write(address, account.clone())?;
        }

        Ok(match self.svm.simulate_transaction(transaction) {
            Ok(info) => self.succeeded(&info, observe),
            Err(failed) => failed_result(&failed),
        })
    }

    /// An upgrade changes the program data and not the program account, so each program that reads
    /// rewritten program data loads again.
    fn forget_programs_of(&mut self, program_data: &Address, loaded: &Loaded) {
        let reads = |account: &Account| account.data.get(PROGRAM_DATA_ADDRESS) == Some(&program_data.0[..]);
        let programs = loaded.accounts.iter().filter(|(_, account)| account.as_ref().is_some_and(reads));

        for (program, _) in programs {
            self.loaded.remove(program);
        }
    }

    /// Writes an account as the cache holds it, and returns whether it wrote one. An account that
    /// does not exist is written empty, so that no copy from an earlier simulation stays. A program
    /// loads again only when its bytes differ from the ones that LiteSVM holds.
    fn write(&mut self, address: &Address, account: Option<Account>) -> Result<bool, ChainError> {
        let native = account.as_ref().is_some_and(|account| owned_by(account, &native_loader::ID));
        let missing_sysvar = account.is_none() && SYSVARS.contains(&rpc::solana_address(*address));

        if rpc::solana_address(*address) == sysvar::instructions::ID || native || missing_sysvar {
            return Ok(false);
        }

        let account = account.unwrap_or(Account { owner: Address::default(), lamports: 0, data: Vec::new() });
        let executable = is_program(&account);
        let loads_code = executable || owned_by(&account, &bpf_loader_upgradeable::ID);
        let fingerprint = self.hasher.hash_one((&account.data, account.lamports, account.owner.0));

        if loads_code && self.loaded.get(address) == Some(&fingerprint) {
            return Ok(false);
        }

        let svm_account = SvmAccount {
            lamports: account.lamports,
            data: account.data,
            owner: rpc::solana_address(account.owner),
            executable,
            rent_epoch: u64::MAX,
        };
        self.svm
            .set_account(rpc::solana_address(*address), svm_account)
            .map_err(|error| ChainError::Decode(format!("LiteSVM refused {}: {error}", rpc::base58(*address))))?;

        if loads_code {
            self.loaded.insert(*address, fingerprint);
        }

        Ok(true)
    }

    /// Each observed account after the run, from LiteSVM's post-state, or as it was when the
    /// transaction did not write it. An account with no lamports does not exist.
    fn succeeded(&self, info: &SimulatedTransactionInfo, observe: &[Address]) -> SimulationResult {
        let after = |address: &Address| {
            let key = rpc::solana_address(*address);
            let written =
                info.post_accounts.iter().find(|(post, _)| *post == key).map(|(_, account)| account.clone().into());
            let account: Option<SvmAccount> = written.or_else(|| self.svm.get_account(&key));

            account.filter(|account| account.lamports > 0).map(|account| Account {
                owner: Address(account.owner().to_bytes()),
                lamports: account.lamports,
                data: account.data,
            })
        };

        SimulationResult { error: None, accounts: observe.iter().map(after).collect(), ..metadata(&info.meta) }
    }
}

fn failed_result(failed: &FailedTransactionMetadata) -> SimulationResult {
    SimulationResult { error: Some(format!("{:?}", failed.err)), ..metadata(&failed.meta) }
}

fn metadata(meta: &litesvm::types::TransactionMetadata) -> SimulationResult {
    let return_data = (!meta.return_data.data.is_empty()).then(|| ReturnData {
        program: Address(meta.return_data.program_id.to_bytes()),
        data: meta.return_data.data.clone(),
    });

    SimulationResult {
        error: None,
        logs: meta.logs.clone(),
        return_data,
        accounts: Vec::new(),
        units_consumed: Some(meta.compute_units_consumed),
        loaded_accounts_data_size: Some(meta.loaded_accounts_data_size),
        fee: Some(meta.fee),
    }
}

/// An account that holds a program: an upgradeable program, which names its program data, or the
/// code itself under an older BPF loader. The cache does not keep the `executable` flag, so the
/// owner and the layout decide.
fn is_program(account: &Account) -> bool {
    let upgradeable = owned_by(account, &bpf_loader_upgradeable::ID) && account.data.len() == PROGRAM_DATA_ADDRESS.end;
    let older_loader = owned_by(account, &bpf_loader::ID) || owned_by(account, &bpf_loader_deprecated::ID);

    upgradeable || older_loader && account.data.starts_with(b"\x7fELF")
}

fn owned_by(account: &Account, program: &solana_address::Address) -> bool {
    rpc::solana_address(account.owner) == *program
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use base64::Engine as _;
    use serde_json::{json, Value};
    use solana_rpc_client::mock_sender::MocksMap;
    use solana_rpc_client::nonblocking::rpc_client::RpcClient;
    use solana_rpc_client_api::request::RpcRequest;

    use sdp_intents_planner::{AccountMeta, Budget, Instruction, Transaction};
    use sdp_intents_spec::AccountRole;

    use super::*;
    use crate::SimulateIn;

    const SOL: u64 = 1_000_000_000;

    fn account(owner: &solana_address::Address, lamports: u64, data: &[u8], executable: bool) -> Value {
        let data = base64::engine::general_purpose::STANDARD.encode(data);

        json!({ "lamports": lamports, "data": [data, "base64"], "owner": owner.to_string(), "executable": executable, "rentEpoch": 0, "space": 0 })
    }

    /// A clock at slot 100, in its 40-byte layout.
    fn clock() -> Vec<u8> {
        [
            100u64.to_le_bytes(),
            0i64.to_le_bytes(),
            1u64.to_le_bytes(),
            1u64.to_le_bytes(),
            1_700_000_000i64.to_le_bytes(),
        ]
        .concat()
    }

    /// The simulator fetches the System program, the payer, the recipient, and the clock, sorted by
    /// address, in one call, and runs the transfer in LiteSVM with no `simulateTransaction`.
    #[tokio::test]
    async fn simulates_a_sol_transfer_in_process() {
        let payer = Address([1; 32]);
        let recipient = Address([2; 32]);
        let answer = json!({ "context": { "slot": 5 }, "value": [
            account(&native_loader::ID, 1, b"system_program", true),
            account(&solana_sdk_ids::system_program::ID, 10 * SOL, &[], false),
            Value::Null,
            account(&sysvar::ID, 1_169_280, &clock(), false),
        ] });
        let mocks: MocksMap = [(RpcRequest::GetMultipleAccounts, answer)].into_iter().collect();
        let rpc = CachedRpc::with_client(
            RpcClient::new_mock_with_mocks_map("fails", mocks),
            "ws://unused",
            Duration::from_secs(60),
            SimulateIn::Process,
        );
        let transfer = Instruction {
            program: Address::default(),
            accounts: vec![
                AccountMeta { address: payer, role: AccountRole::WritableSigner },
                AccountMeta { address: recipient, role: AccountRole::Writable },
            ],
            data: [&2u32.to_le_bytes()[..], &SOL.to_le_bytes()].concat(),
        };
        let simulation = Simulation {
            transaction: Transaction {
                fee_payer: payer,
                instructions: vec![transfer],
                budget: Budget::MAXIMUM,
                priority_fee_lamports: 0,
            },
            observe: vec![recipient],
            fixed: None,
        };

        let result = rpc.simulate(&simulation).await.unwrap();

        assert_eq!(result.error, None, "{:?}", result.logs);
        assert_eq!(result.accounts.first().cloned().flatten().map(|account| account.lamports), Some(SOL));
        assert_eq!(rpc.calls().simulate_transaction, 0);
        assert_eq!(rpc.calls().get_multiple_accounts, 1);
    }
}
