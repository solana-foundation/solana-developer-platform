//! Everything that touches the zolana SDK.
//!
//! Confined to this module. SDP never learns the Photon or prover wire formats,
//! and a zolana revision bump has one blast radius inside this service.

pub mod authority;
pub mod preflight;
