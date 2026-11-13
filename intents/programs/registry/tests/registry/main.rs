//! The registry program in LiteSVM: its instructions, then `verify_intent` for static and program
//! recipes against plans from the real planner.

mod client;
mod fixture;
mod flows;
mod guarded;
mod intents;
mod plans;
mod registry_client;
mod svm;
mod token;
mod verifier;
mod verify_program;
mod verify_remote;
mod verify_static;
