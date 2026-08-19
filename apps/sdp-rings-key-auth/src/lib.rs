//! Internal custody boundary for Helius Rings key material.
//!
//! This crate is contract-first. Production storage, encryption, authorization,
//! and gateway adapters are intentionally absent until their interfaces are
//! reviewed. The default application therefore serves liveness and fails closed
//! for every key-bearing operation.

pub mod config;
pub mod domain;
pub mod error;
pub mod extract;
pub mod gateway;
pub mod ports;
pub mod routes;
pub mod state;
pub mod validate;
pub mod wire;
