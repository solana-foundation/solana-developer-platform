//! Turns an intent into a plan, with no IO. The planner returns each fetch and each simulation that
//! the plan needs, and its caller answers them. The client answers with RPC, and the service answers
//! from its cache and its own simulator. Both run the same planner.
//!
//! ```
//! use sdp_intents_planner::{Account, AccountMap, Plan, PlanError, PlanRequest, Planner, Simulation, SimulationResult, Step};
//! use sdp_intents_spec::Address;
//!
//! trait Rpc {
//!     fn get_multiple_accounts(&self, addresses: &[Address]) -> Vec<Option<Account>>;
//!     fn simulate(&self, simulation: &Simulation) -> SimulationResult;
//! }
//!
//! fn plan(rpc: &impl Rpc, request: &PlanRequest<'_>, scratch: Address) -> Result<Plan, PlanError> {
//!     let mut planner = Planner::new(request, scratch)?;
//!     let mut accounts = AccountMap::default();
//!
//!     loop {
//!         match planner.next(&accounts)? {
//!             Step::Fetch(addresses) => accounts.insert_fetched(&addresses, rpc.get_multiple_accounts(&addresses)),
//!             Step::Simulate(simulation) => planner.simulated(rpc.simulate(&simulation))?,
//!             Step::Done(plan) => return Ok(*plan),
//!         }
//!     }
//! }
//! ```
//!
//! A builder call runs as a v1 transaction that first creates scratch, then calls the builder with
//! scratch last. The simulation checks no signatures and lands nothing, so scratch needs no keypair
//! and no one pays its rent.

mod accounts;
mod error;
mod instruction;
mod onchain;
mod plan;
mod planner;
mod registry;
mod render;
mod segment;
mod simulation;
mod transaction;
mod values;
mod verifier;
mod verify;

#[cfg(test)]
mod test_support;

pub use accounts::{Account, AccountMap};
pub use error::{Limit, PlanError};
pub use instruction::{AccountMeta, Instruction};
pub use plan::{Digests, Plan, PlannedIntent};
pub use planner::{PlanRequest, Planner, Step};
pub use registry::REGISTRY_PROGRAM;
pub use sdp_intents_engine::Payers;
pub use simulation::{ReturnData, Simulation, SimulationResult};
pub use transaction::{Budget, RequiredSignature, SignerRole, Transaction};
pub use verifier::{verify_transaction, VerifiedIntent, VerifiedTransaction, VerifyError, VerifyStep};

/// The compiled documents of one intent.
#[derive(Clone, Copy, Debug)]
pub struct IntentDocuments<'a> {
    pub interface: &'a [u8],
    pub implementation: &'a [u8],
    pub intent: &'a [u8],
}
