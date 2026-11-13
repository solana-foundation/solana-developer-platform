//! Turns the binary form of an interface or an implementation back into the JSON that
//! `intents/definitions` uses. The JSON compiles to the same bytes again.
//!
//! allow-verbose: the dropped keys and the canonical spellings are the output contract.
//!
//! The compiler drops these, so the JSON does not have them:
//! - `annotations`, the top-level `name`, and the formatting of the file.
//! - Each key that states a default: `"signer": false`, `"optional": false`, `"writable": false`,
//!   `"settlement": "atomic"`, and an empty `applies`, `postConditions`, remote `accounts`, or
//!   recipe `outputs`.
//! - The program accounts that the compiler adds for instructions (see `programs.rs`).
//!
//! When several spellings compile to the same bytes, the JSON uses one of them:
//! - `cluster` is `mainnet`, `devnet`, or `testnet`. Another cluster is its base58 genesis hash.
//! - `implements` is the shortest caret range of the lowest version: `^1`, `^1.2`, or `^1.2.3`.
//! - A literal segment is `hex`, except a seed of printable ASCII, which is `utf8`.
//! - A discriminator is lowercase `hex`. An empty discriminator is left out.
//! - An interface always has `outputs` and `postConditions`, also when they are empty.
//! - Keys come in the order that the definitions use. An account has its flags after an address
//!   text, and before an address object.

mod accounts;
mod error;
mod implementation;
mod interface;
mod json;
mod names;
mod post_condition;
mod programs;
mod recipe;

#[cfg(test)]
mod tests;

use std::collections::HashMap;

use sdp_intents_spec::wire::DocumentIdV1;
use sdp_intents_spec::Address;

pub use error::DecompileError;
pub use implementation::decompile_implementation;
pub use interface::decompile_interface;

use crate::id::Id;
use json::utf8;

/// Organization names by publisher address. The registry derives an organization's address from its name.
pub type Organizations = HashMap<Address, String>;

/// `solana.org/token.transfer`: the organization of the publisher, and the name that the id hashes.
fn document_name(id: &DocumentIdV1, name: &[u8], organizations: &Organizations) -> Result<String, DecompileError> {
    let organization = organizations.get(&id.publisher).ok_or(DecompileError::UnknownPublisher(id.publisher))?;
    let named = Id { organization: organization.clone(), name: utf8(name)?.to_owned() };

    if named.name_hash() != id.name_hash {
        return Err(DecompileError::NameMismatch);
    }

    Ok(named.to_string())
}
