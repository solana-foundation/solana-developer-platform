//! The `ExtraAccountMetaList` of a transfer hook, read in place, in the layouts of
//! `spl-tlv-account-resolution` 0.11.
//!
//! allow-verbose: the builder parses these bytes onchain, so the layout is the contract.
//! - The account holds TLV entries: an 8-byte discriminator, a `u32` length, and the value. The
//!   list is the value of the first entry with [`EXECUTE_DISCRIMINATOR`].
//! - The value is a `u32` count, then that many 35-byte [`ExtraAccountMetaV1`].
//! - A meta's discriminator says how `address_config` names the address: `0` the address itself,
//!   `1` a PDA of the hook program, `2` an address in account data or instruction data, and
//!   `128 + i` a PDA of the program at account index `i`.
//! - A PDA config is a list of seeds, each a tag and its fields, and a zero tag ends it.

use alloc::vec::Vec;

use bytemuck::{Pod, Zeroable};
use pinocchio::address::Address;

use crate::refusal::Refusal;

/// The seed of the meta list PDA, with the mint after it.
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";
/// The first 8 bytes of SHA-256 of `spl-transfer-hook-interface:execute`.
pub const EXECUTE_DISCRIMINATOR: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];

const META_FIXED: u8 = 0;
const META_HOOK_PDA: u8 = 1;
const META_ADDRESS_IN_DATA: u8 = 2;
const META_EXTERNAL_PDA: u8 = 128;

const SEED_END: u8 = 0;
const SEED_LITERAL: u8 = 1;
const SEED_INSTRUCTION_DATA: u8 = 2;
const SEED_ACCOUNT_KEY: u8 = 3;
const SEED_ACCOUNT_DATA: u8 = 4;

const ADDRESS_IN_INSTRUCTION_DATA: u8 = 1;
const ADDRESS_IN_ACCOUNT_DATA: u8 = 2;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct ExtraAccountMetaV1 {
    pub discriminator: u8,
    pub address_config: [u8; 32],
    pub is_signer: u8,
    pub is_writable: u8,
}

/// How a meta names its address. Indexes are into the accounts of the hook's `Execute`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AddressConfig<'c> {
    Fixed(Address),
    Pda { program: PdaProgram, seeds: Vec<Seed<'c>> },
    InAccountData { account_index: u8, data_index: u8 },
    InInstructionData { index: u8 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PdaProgram {
    Hook,
    AtAccount(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seed<'c> {
    Literal(&'c [u8]),
    InstructionData { index: u8, length: u8 },
    AccountKey { index: u8 },
    AccountData { account_index: u8, data_index: u8, length: u8 },
}

/// The metas of the first `Execute` entry of a meta list account.
pub fn extra_account_metas(data: &[u8]) -> Result<&[ExtraAccountMetaV1], Refusal> {
    let mut entries = data;

    while let Some((discriminator, rest)) = entries.split_first_chunk::<8>() {
        if *discriminator == [0; 8] {
            break;
        }

        let (length, rest) = rest.split_first_chunk::<4>().ok_or(Refusal::HookUnresolvable)?;
        let length = usize::try_from(u32::from_le_bytes(*length)).map_err(|_| Refusal::HookUnresolvable)?;
        let value = rest.get(..length).ok_or(Refusal::HookUnresolvable)?;

        if *discriminator == EXECUTE_DISCRIMINATOR {
            return metas(value);
        }

        entries = rest.get(length..).ok_or(Refusal::HookUnresolvable)?;
    }

    Err(Refusal::HookUnresolvable)
}

fn metas(list: &[u8]) -> Result<&[ExtraAccountMetaV1], Refusal> {
    let (count, items) = list.split_first_chunk::<4>().ok_or(Refusal::HookUnresolvable)?;
    let count = usize::try_from(u32::from_le_bytes(*count)).map_err(|_| Refusal::HookUnresolvable)?;
    let items_len = count.checked_mul(size_of::<ExtraAccountMetaV1>()).ok_or(Refusal::HookUnresolvable)?;
    let items = items.get(..items_len).ok_or(Refusal::HookUnresolvable)?;

    bytemuck::try_cast_slice(items).map_err(|_| Refusal::HookUnresolvable)
}

impl ExtraAccountMetaV1 {
    pub fn address_config(&self) -> Result<AddressConfig<'_>, Refusal> {
        match self.discriminator {
            META_FIXED => Ok(AddressConfig::Fixed(Address::new_from_array(self.address_config))),
            META_HOOK_PDA => Ok(AddressConfig::Pda { program: PdaProgram::Hook, seeds: seeds(&self.address_config)? }),
            META_ADDRESS_IN_DATA => address_in_data(&self.address_config),
            index @ META_EXTERNAL_PDA.. => Ok(AddressConfig::Pda {
                program: PdaProgram::AtAccount(index.saturating_sub(META_EXTERNAL_PDA)),
                seeds: seeds(&self.address_config)?,
            }),
            _ => Err(Refusal::HookUnresolvable),
        }
    }
}

fn address_in_data(config: &[u8; 32]) -> Result<AddressConfig<'_>, Refusal> {
    match config {
        [ADDRESS_IN_INSTRUCTION_DATA, index, ..] => Ok(AddressConfig::InInstructionData { index: *index }),
        [ADDRESS_IN_ACCOUNT_DATA, account_index, data_index, ..] => {
            Ok(AddressConfig::InAccountData { account_index: *account_index, data_index: *data_index })
        }
        _ => Err(Refusal::HookUnresolvable),
    }
}

/// A seed and the config bytes after it.
struct ParsedSeed<'c> {
    seed: Seed<'c>,
    rest: &'c [u8],
}

pub fn seeds(config: &[u8; 32]) -> Result<Vec<Seed<'_>>, Refusal> {
    let mut seeds = Vec::new();
    let mut rest: &[u8] = config;

    while let Some((tag, fields)) = rest.split_first() {
        if *tag == SEED_END {
            break;
        }

        let parsed = seed(*tag, fields).ok_or(Refusal::HookUnresolvable)?;
        seeds.push(parsed.seed);
        rest = parsed.rest;
    }

    Ok(seeds)
}

fn seed(tag: u8, fields: &[u8]) -> Option<ParsedSeed<'_>> {
    match (tag, fields) {
        (SEED_LITERAL, [length, bytes @ ..]) => {
            let length = usize::from(*length);

            Some(ParsedSeed { seed: Seed::Literal(bytes.get(..length)?), rest: bytes.get(length..)? })
        }
        (SEED_INSTRUCTION_DATA, [index, length, rest @ ..]) => {
            Some(ParsedSeed { seed: Seed::InstructionData { index: *index, length: *length }, rest })
        }
        (SEED_ACCOUNT_KEY, [index, rest @ ..]) => Some(ParsedSeed { seed: Seed::AccountKey { index: *index }, rest }),
        (SEED_ACCOUNT_DATA, [account_index, data_index, length, rest @ ..]) => Some(ParsedSeed {
            seed: Seed::AccountData { account_index: *account_index, data_index: *data_index, length: *length },
            rest,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use solana_sha256_hasher::hashv;

    use super::*;

    fn config(bytes: &[u8]) -> [u8; 32] {
        let mut config = [0; 32];
        config[..bytes.len()].copy_from_slice(bytes);

        config
    }

    fn meta(discriminator: u8, address_config: [u8; 32], is_writable: bool) -> ExtraAccountMetaV1 {
        ExtraAccountMetaV1 { discriminator, address_config, is_signer: 0, is_writable: u8::from(is_writable) }
    }

    /// A TLV entry: the discriminator, the `u32` length, and the value.
    fn entry(discriminator: [u8; 8], value: &[u8]) -> Vec<u8> {
        [&discriminator[..], &u32::try_from(value.len()).unwrap().to_le_bytes(), value].concat()
    }

    fn list(metas: &[ExtraAccountMetaV1]) -> Vec<u8> {
        [&u32::try_from(metas.len()).unwrap().to_le_bytes()[..], bytemuck::cast_slice(metas)].concat()
    }

    #[test]
    fn the_execute_discriminator_is_the_hash_of_its_name() {
        let hash = hashv(&[b"spl-transfer-hook-interface:execute"]).to_bytes();

        assert_eq!(hash[..8], EXECUTE_DISCRIMINATOR);
        assert_eq!(size_of::<ExtraAccountMetaV1>(), 35);
    }

    #[test]
    fn reads_the_execute_entry_after_another_entry() {
        let metas = [meta(META_FIXED, [4; 32], true), meta(META_HOOK_PDA, config(&[1, 1, b'a']), false)];
        let data = [entry([9; 8], &[1, 2, 3]), entry(EXECUTE_DISCRIMINATOR, &list(&metas))].concat();

        assert_eq!(extra_account_metas(&data), Ok(&metas[..]));
    }

    #[test]
    fn a_list_longer_than_its_entry_is_unresolvable() {
        let mut value = list(&[meta(META_FIXED, [4; 32], true)]);
        value[0] = 2;

        assert_eq!(extra_account_metas(&entry(EXECUTE_DISCRIMINATOR, &value)), Err(Refusal::HookUnresolvable));
        assert_eq!(extra_account_metas(&[]), Err(Refusal::HookUnresolvable));
    }

    #[test]
    fn reads_each_kind_of_seed() {
        let config = config(&[1, 6, b'c', b'o', b'n', b'f', b'i', b'g', 2, 8, 8, 3, 2, 4, 0, 32, 32]);

        assert_eq!(
            seeds(&config),
            Ok(vec![
                Seed::Literal(b"config"),
                Seed::InstructionData { index: 8, length: 8 },
                Seed::AccountKey { index: 2 },
                Seed::AccountData { account_index: 0, data_index: 32, length: 32 },
            ])
        );
    }

    #[test]
    fn a_seed_past_the_config_is_unresolvable() {
        let mut account_data_at_the_end = [1; 32];
        account_data_at_the_end[1] = 29;
        account_data_at_the_end[31] = SEED_ACCOUNT_DATA;

        assert_eq!(seeds(&config(&[SEED_LITERAL, 31])), Err(Refusal::HookUnresolvable));
        assert_eq!(seeds(&account_data_at_the_end), Err(Refusal::HookUnresolvable));
        assert_eq!(seeds(&config(&[5])), Err(Refusal::HookUnresolvable));
    }

    #[test]
    fn reads_each_kind_of_address_config() {
        let in_account_data = meta(META_ADDRESS_IN_DATA, config(&[2, 5, 8]), false);
        let in_instruction_data = meta(META_ADDRESS_IN_DATA, config(&[1, 8]), false);

        assert_eq!(
            meta(META_FIXED, [4; 32], false).address_config(),
            Ok(AddressConfig::Fixed(Address::new_from_array([4; 32])))
        );
        assert_eq!(
            meta(130, config(&[3, 1]), false).address_config(),
            Ok(AddressConfig::Pda { program: PdaProgram::AtAccount(2), seeds: vec![Seed::AccountKey { index: 1 }] })
        );
        assert_eq!(
            in_account_data.address_config(),
            Ok(AddressConfig::InAccountData { account_index: 5, data_index: 8 })
        );
        assert_eq!(in_instruction_data.address_config(), Ok(AddressConfig::InInstructionData { index: 8 }));
        assert_eq!(meta(3, [0; 32], false).address_config(), Err(Refusal::HookUnresolvable));
        assert_eq!(meta(META_ADDRESS_IN_DATA, [0; 32], false).address_config(), Err(Refusal::HookUnresolvable));
    }
}
