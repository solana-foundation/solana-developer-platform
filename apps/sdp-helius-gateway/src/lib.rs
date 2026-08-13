//! Stateless HTTP gateway over the Helius Rings (zolana) Rust SDK.
//!
//! SDP owns key custody, operation state, policy, approvals, custody signing, fee
//! sponsorship and RPC submission. This service owns everything that touches
//! zolana wire formats, and holds nothing durable — no database, no KMS key, no
//! disk, no cursor. Every call is a pure function of its request.
//!
//! Scope is the **default ring** only: instruction tags 11 (`DEPOSIT`), 12
//! (`TRANSACT`) and 13 (`MERGE_TRANSACT`). Policy rings are out of scope because
//! every policy-ring instruction requires the ring config account to sign, which
//! only a deployed ring program can produce via `invoke_signed`, and ring creation
//! is permissioned on devnet with an unfunded authority.
//!
//! Start with [`wire`] — it is the contract, and it documents the invariants
//! callers depend on.
//!
//! # Why this is a library with a thin binary
//!
//! So `tests/` can exercise the real router. An integration test cannot import a
//! binary-only crate, and asserting the HTTP contract through the actual `Router`
//! rather than by calling handlers directly is the difference between testing the
//! contract and testing the functions behind it.

pub mod auth;
pub mod config;
pub mod error;
pub mod extract;
pub mod redact;
pub mod routes;
pub mod state;
pub mod validate;
pub mod wire;
pub mod zolana;
