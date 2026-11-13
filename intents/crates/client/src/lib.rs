//! Plans intents over RPC, with no service. It answers the planner's fetches with
//! `getMultipleAccounts`, and its simulations with `simulateTransaction`.
//!
//! ```no_run
//! # fn run(request: &sdp_intents_planner::PlanRequest<'_>) -> Result<(), sdp_intents_client::ClientError> {
//! let client = sdp_intents_client::Client::new("https://api.mainnet-beta.solana.com");
//! let prepared = client.prepare(request)?;
//! let verified = client.verify_message(&prepared.message)?;
//! assert_eq!(verified.message, prepared.plan.message);
//! # Ok(())
//! # }
//! ```

mod rpc;
mod verify;

use core::fmt;
use std::hash::{BuildHasher, RandomState};

use solana_account_decoder_client_types::UiAccountEncoding;
use solana_commitment_config::CommitmentConfig;
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_api::config::{RpcSimulateTransactionAccountsConfig, RpcSimulateTransactionConfig};

use solana_message::v1::{MAX_TRANSACTION_SIZE, SIGNATURE_SIZE};

use sdp_intents_planner::{
    Account, AccountMap, Limit, Plan, PlanError, PlanRequest, Planner, Simulation, SimulationResult, Step,
};
use sdp_intents_spec::Address;

/// `getMultipleAccounts` takes at most 100 addresses.
const MAX_ACCOUNTS_PER_FETCH: usize = 100;

pub struct Client {
    rpc: RpcClient,
}

/// A plan, with its transaction compiled for the signers.
#[derive(Clone, Debug)]
pub struct Prepared {
    pub plan: Plan,
    /// The v1 message that the signers sign, with a recent `confirmed` blockhash.
    pub message: Vec<u8>,
}

impl Client {
    /// Reads and simulates at `processed`, as the service does.
    pub fn new(url: impl ToString) -> Self {
        Self { rpc: RpcClient::new_with_commitment(url.to_string(), CommitmentConfig::processed()) }
    }

    pub fn prepare(&self, request: &PlanRequest<'_>) -> Result<Prepared, ClientError> {
        let mut planner = Planner::new(request, fresh_address())?;
        let mut accounts = AccountMap::default();

        let plan = loop {
            match planner.next(&accounts)? {
                Step::Fetch(addresses) => accounts.insert_fetched(&addresses, self.fetch(&addresses)?),
                Step::Simulate(simulation) => planner.simulated(self.simulate(&simulation)?)?,
                Step::Done(plan) => break plan,
            }
        };

        let (blockhash, _) = self.rpc.get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())?;
        let message = rpc::message(&plan.transaction, blockhash)?;
        let signatures = usize::from(message.header.num_required_signatures);
        let message = message.serialize();
        let size = message.len().saturating_add(signatures.saturating_mul(SIGNATURE_SIZE));

        if size > MAX_TRANSACTION_SIZE {
            return Err(PlanError::DoesNotFit { limit: Limit::Bytes, used: size, max: MAX_TRANSACTION_SIZE }.into());
        }

        Ok(Prepared { plan: *plan, message })
    }

    fn fetch(&self, addresses: &[Address]) -> Result<Vec<Option<Account>>, ClientError> {
        let mut fetched = Vec::with_capacity(addresses.len());

        for chunk in addresses.chunks(MAX_ACCOUNTS_PER_FETCH) {
            let keys: Vec<solana_address::Address> = chunk.iter().copied().map(rpc::solana_address).collect();
            let response = self.rpc.get_multiple_accounts_with_commitment(&keys, CommitmentConfig::processed())?;

            fetched.extend(response.value.into_iter().map(|account| {
                account.map(|account| Account {
                    owner: Address(account.owner.to_bytes()),
                    lamports: account.lamports,
                    data: account.data,
                })
            }));
        }

        Ok(fetched)
    }

    fn simulate(&self, simulation: &Simulation) -> Result<SimulationResult, ClientError> {
        let config = RpcSimulateTransactionConfig {
            sig_verify: false,
            replace_recent_blockhash: true,
            commitment: Some(CommitmentConfig::processed()),
            accounts: Some(RpcSimulateTransactionAccountsConfig {
                encoding: Some(UiAccountEncoding::Base64),
                addresses: simulation.observe.iter().copied().map(rpc::base58).collect(),
            }),
            ..RpcSimulateTransactionConfig::default()
        };
        let response = self.rpc.simulate_transaction_with_config(&rpc::simulation_transaction(simulation)?, config)?;

        rpc::simulation_result(response.value)
    }
}

/// A scratch address that others cannot predict, so that no one can create an account there
/// first. Each `RandomState` hashes with new random keys.
fn fresh_address() -> Address {
    let mut bytes = [0u8; 32];

    for (chunk, word) in bytes.as_chunks_mut::<8>().0.iter_mut().zip(0u64..) {
        *chunk = RandomState::new().hash_one(word).to_le_bytes();
    }

    Address(bytes)
}

#[derive(Debug)]
pub enum ClientError {
    Plan(PlanError),
    Rpc(Box<solana_rpc_client_api::client_error::Error>),
    /// The simulation transaction does not compile, such as one over the account limit.
    Compile(String),
    /// The RPC answer or the message does not decode.
    Decode(String),
    /// The transaction does not verify.
    Verify(sdp_intents_planner::VerifyError),
}

impl From<PlanError> for ClientError {
    fn from(error: PlanError) -> Self {
        Self::Plan(error)
    }
}

impl From<sdp_intents_planner::VerifyError> for ClientError {
    fn from(error: sdp_intents_planner::VerifyError) -> Self {
        Self::Verify(error)
    }
}

impl From<solana_rpc_client_api::client_error::Error> for ClientError {
    fn from(error: solana_rpc_client_api::client_error::Error) -> Self {
        Self::Rpc(Box::new(error))
    }
}

impl From<base64::DecodeError> for ClientError {
    fn from(error: base64::DecodeError) -> Self {
        Self::Decode(error.to_string())
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Plan(error) => write!(f, "{error}"),
            Self::Rpc(error) => write!(f, "the RPC call failed: {error}"),
            Self::Compile(error) => write!(f, "the simulation does not compile: {error}"),
            Self::Decode(error) => write!(f, "the answer does not decode: {error}"),
            Self::Verify(error) => write!(f, "the transaction does not verify: {error}"),
        }
    }
}

impl std::error::Error for ClientError {}

#[cfg(test)]
mod tests {
    use sdp_intents_compiler::Catalog;
    use sdp_intents_planner::{IntentDocuments, Payers};

    use super::*;

    #[test]
    fn each_scratch_address_is_new() {
        assert_ne!(fresh_address(), fresh_address());
    }

    /// Prepares the mainnet USDC transfer of the fixtures against `SDP_INTENTS_RPC_URL`, a mainnet
    /// RPC: two fetches, the final simulation, and the checks.
    #[test]
    #[ignore = "needs a mainnet RPC in SDP_INTENTS_RPC_URL"]
    fn plans_an_spl_transfer_over_rpc() {
        let url = std::env::var("SDP_INTENTS_RPC_URL").unwrap();
        let mut catalog = Catalog::default().with_publisher("solana.org", Address([7; 32]));
        catalog
            .compile_interface(include_str!("../../../definitions/solana.org/interfaces/token.transfer/1.0.0.json"))
            .unwrap();
        catalog
            .compile_implementation(include_str!(
                "../../../definitions/solana.org/implementations/spl-token-transfer/1.0.0.json"
            ))
            .unwrap();
        let plan = catalog.compile_plan(include_str!("../../../fixtures/plans/mainnet/usdc-transfer.json")).unwrap();
        let request = PlanRequest {
            intents: plan
                .intents
                .iter()
                .map(|intent| IntentDocuments {
                    interface: &intent.interface.bytes,
                    implementation: &intent.implementation.bytes,
                    intent: &intent.bytes,
                })
                .collect(),
            payers: Payers { fee: &plan.payers.fee, rent: &plan.payers.rent },
            priority_fee_lamports: plan.priority_fee_lamports,
        };

        let prepared = Client::new(url).prepare(&request).unwrap();

        assert_eq!(prepared.plan.intents[0].span.len(), 2);
        assert_eq!(prepared.message.first(), Some(&0x81));
    }
}
