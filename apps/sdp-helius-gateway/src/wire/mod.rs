// This module declares the contract; its consumers are the flow handlers, which
// are not implemented. Until they are, every request field is deserialized but
// never read, which is what `dead_code` reports. Scoped to this module rather than
// the crate so that dead code elsewhere still fails the build.
//
// Remove this once the handlers are implemented. If warnings reappear then, they
// mean a field is in the contract that nothing uses.
#![allow(dead_code)]

//! The HTTP contract between `apps/sdp-api` and this gateway.
//!
//! # Two invariants callers depend on
//!
//! **1. Idempotency belongs to SDP.** This service is stateless, so it cannot
//! deduplicate. [`Preamble::request_id`](crate::wire::common::Preamble::request_id)
//! exists for log correlation only.
//! Exactly-once execution comes from SDP pinning the input set at intent time
//! behind a partial unique index on nullifier.
//!
//! Nullifiers are a pure function of
//! `(nullifier_key, utxo_hash, blinding)`, so for a *fixed* input set they are
//! byte-identical across attempts and the on-chain nullifier queue enforces
//! at-most-once. But the input set is re-derived from a re-synced wallet on
//! every attempt. If SDP loses the response after a submission landed, the next
//! attempt sees those notes as spent, selects *different* ones, and produces a
//! disjoint nullifier set — so both transactions are valid and both can land.
//! That double-pays the recipient. Pinning the input set is the only defence.
//!
//! **2. The proof commits the fee payer and the owner-signer set. It does not
//! commit the blockhash or the compute-budget instructions.** So between
//! [`prove`] and [`assemble`], re-blockhashing and adjusting the compute-unit
//! price are safe; changing the fee payer or the owner set is not — the circuit
//! carries the payer in public-input slot zero, and assembly validates it.
//!
//! # Why proving and assembly are separate endpoints
//!
//! The SDK's `build_private_transaction` fetches a blockhash *before* calling
//! the prover, which can take minutes — the gateway caps it at 600 seconds because
//! nothing upstream does. A Solana blockhash lives about 60–90 seconds, so that
//! helper — the one documented path for an HSM or custodian — returns a transaction
//! that is usually already expired. Splitting the two lets SDP fetch a blockhash
//! only once a proof is in hand.
//!
//! # Encoding conventions
//!
//! - Solana addresses and Ed25519 public keys: base58, the ecosystem convention.
//! - Non-Solana key material: standard base64. This covers compressed P256 points
//!   (33 bytes) and BN254 field elements — neither has a base58 convention, and a
//!   viewing pubkey is not an address.
//! - Digests, instruction data, serialized transactions: standard base64.
//! - **`u64` amounts: decimal strings, never JSON numbers.** SDP parses JSON
//!   numbers as IEEE-754 doubles, which lose precision above 2^53−1; lamport and
//!   token amounts exceed that. Slots stay numbers — they are far below the limit.
//! - Every request type sets `deny_unknown_fields`. A typed contract should
//!   reject drift loudly rather than silently ignore a field SDP believed it
//!   sent.
//!
//! Wire types do not reuse `solana_address::Address` or other SDK types.
//! Decoupling the JSON representation from SDK internals means a zolana bump
//! cannot silently change our public contract.

pub mod assemble;
pub mod common;
pub mod health;
pub mod merging;
pub mod nullifiers;
pub mod plan;
pub mod prove;
pub mod register;
pub mod shield;
pub mod sync;
