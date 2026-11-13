//! Plans intents over RPC, with no service. It answers the planner's fetches with
//! `getMultipleAccounts`, and its simulations with `simulateTransaction`.
//!
//! [`rpc`] holds the conversions, so a service with its own cache can answer the planner the same
//! way.
//!
//! ```no_run
//! # fn run(request: &sdp_intents_planner::PlanRequest<'_>) -> Result<(), sdp_intents_client::ClientError> {
//! let client = sdp_intents_client::Client::new("https://api.mainnet-beta.solana.com");
//! let prepared = client.prepare(request)?;
//! let compiled = prepared.compiled.as_ref().ok_or(sdp_intents_client::ClientError::Decode("no message".into()))?;
//! let verified = client.verify_message(compiled.message.bytes())?;
//! assert_eq!(verified.message, prepared.plan.message);
//! # Ok(())
//! # }
//! ```

pub mod json;
pub mod remote;
pub mod rpc;
mod send;
mod verify;

use core::fmt;
use std::hash::{BuildHasher, RandomState};

use solana_commitment_config::CommitmentConfig;
use solana_hash::Hash;
use solana_rpc_client::rpc_client::RpcClient;

use sdp_intents_planner::{
    Account, AccountMap, FrozenTransaction, Plan, PlanError, PlanRequest, Planner, RemoteAnswer, Simulation,
    SimulationResult, Step,
};
use sdp_intents_spec::Address;

pub use sdp_intents_message as message;
pub use sdp_intents_message::{MessageError, MessageVersion, WireMessage};
pub use send::{sign, sign_message};
pub use solana_hash::Hash as Blockhash;
pub use solana_keypair::{read_keypair_file, Keypair};
pub use solana_signer::Signer;

/// `getMultipleAccounts` takes at most 100 addresses.
const MAX_ACCOUNTS_PER_FETCH: usize = 100;

pub struct Client {
    rpc: RpcClient,
}

/// A plan, with its transaction compiled for the signers when the request asks for one.
#[derive(Clone, Debug)]
pub struct Prepared {
    pub plan: Plan,
    /// `None` when the request asks for the instructions only, and the caller compiles them.
    pub compiled: Option<Compiled>,
}

#[derive(Clone, Debug)]
pub struct Compiled {
    /// A v1 message with a recent `confirmed` blockhash, or a provider's message as it signed it.
    pub message: WireMessage,
    /// The last block height at which the message can land. A provider's transaction has its own
    /// blockhash, whose height the plan does not know.
    pub last_valid_block_height: Option<u64>,
}

impl Client {
    /// Reads and simulates at `processed`, as the service does.
    pub fn new(url: impl ToString) -> Self {
        Self { rpc: RpcClient::new_with_commitment(url.to_string(), CommitmentConfig::processed()) }
    }

    pub fn prepare(&self, request: &PlanRequest<'_>) -> Result<Prepared, ClientError> {
        let plan = self.plan(request, None)?;
        let (blockhash, last_valid_block_height) =
            self.rpc.get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())?;

        prepared(plan, blockhash, last_valid_block_height)
    }

    /// The plan with no message, for a caller that compiles the instructions into its own
    /// transaction. It reads no blockhash.
    pub fn prepare_instructions(&self, request: &PlanRequest<'_>) -> Result<Prepared, ClientError> {
        instructions_only(self.plan(request, None)?)
    }

    /// Plans `request` again with `frozen` as the endpoint's answer, as the signer of a provider's
    /// transaction verifies it: every postcondition and payer rule is checked in a new simulation.
    /// The plan's message must be the one that the signer was shown.
    pub fn replan(&self, request: &PlanRequest<'_>, frozen: FrozenTransaction) -> Result<Plan, ClientError> {
        self.plan(request, Some(RemoteAnswer { frozen: Some(frozen), ..RemoteAnswer::default() }))
    }

    /// The planner's loop. A remote call takes `answer` when it is set, and the endpoint otherwise.
    fn plan(&self, request: &PlanRequest<'_>, answer: Option<RemoteAnswer>) -> Result<Plan, ClientError> {
        let mut planner = Planner::new(request, fresh_address())?;
        let mut accounts = AccountMap::default();

        loop {
            match planner.next(&accounts)? {
                Step::Fetch(addresses) => accounts.insert_fetched(&addresses, self.fetch(&addresses)?),
                Step::Simulate(simulation) => planner.simulated(self.simulate(&simulation)?)?,
                Step::Call(call) => match &answer {
                    Some(answer) => planner.called(answer.clone())?,
                    None => planner.called(self.call_remote(&call)?)?,
                },
                Step::Done(plan) => return Ok(*plan),
            }
        }
    }

    /// Each account at `addresses`, in order, with `getMultipleAccounts` split at 100.
    pub fn accounts(&self, addresses: &[Address]) -> Result<Vec<Option<Account>>, ClientError> {
        self.fetch(addresses)
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
        let transaction = rpc::simulation_transaction(simulation)?;
        let response = self.rpc.simulate_transaction_with_config(&transaction, rpc::simulation_config(simulation))?;

        rpc::simulation_result(response.value)
    }
}

/// The plan with its v1 message compiled at `blockhash`, or `DoesNotFit` when the signed
/// transaction is over its version's limit. A provider's transaction keeps its own message.
pub fn prepared(plan: Plan, blockhash: Hash, last_valid_block_height: u64) -> Result<Prepared, ClientError> {
    let compiled = match &plan.frozen {
        Some(frozen) => Compiled { message: WireMessage::parse(&frozen.message)?, last_valid_block_height: None },
        None => Compiled {
            message: WireMessage::compile(&plan.transaction, blockhash, MessageVersion::V1, &[])?,
            last_valid_block_height: Some(last_valid_block_height),
        },
    };
    compiled.message.check_size()?;

    Ok(Prepared { plan, compiled: Some(compiled) })
}

/// The plan with no message. A provider signed every byte of its message, so its plan has no
/// instructions to give.
pub fn instructions_only(plan: Plan) -> Result<Prepared, ClientError> {
    if plan.frozen.is_some() {
        return Err(PlanError::RemoteTransaction(
            "a provider's signed transaction has no instructions to give; ask for `output: transaction`",
        )
        .into());
    }

    Ok(Prepared { plan, compiled: None })
}

/// A scratch address that others cannot predict, so that no one can create an account there
/// first. Each `RandomState` hashes with new random keys.
pub fn fresh_address() -> Address {
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
    /// The message needs the signature of this address, and no signer holds its key.
    MissingSigner(String),
    /// A remote recipe's endpoint did not answer, or answered with an error status.
    Remote(String),
}

impl From<PlanError> for ClientError {
    fn from(error: PlanError) -> Self {
        Self::Plan(error)
    }
}

impl From<MessageError> for ClientError {
    fn from(error: MessageError) -> Self {
        match error {
            MessageError::Plan(error) => Self::Plan(error),
            MessageError::Compile(error) => Self::Compile(error),
            MessageError::Decode(error) => Self::Decode(error),
        }
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
            Self::MissingSigner(address) => write!(f, "no signer holds the key of {address}"),
            Self::Remote(error) => write!(f, "the remote endpoint failed: {error}"),
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
        assert_eq!(prepared.compiled.unwrap().message.version(), MessageVersion::V1);
    }
}
