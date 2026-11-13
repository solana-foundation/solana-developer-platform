//! The extra account meta list of the test transfer hook. It names three accounts, so the builder
//! needs one round for the list and one round for data:
//!
//! 1. `config`, a PDA of the hook with the seed `config`. Its data holds the treasury address.
//! 2. `counter`, writable, a PDA of the hook with the seed `counter` and the owner of the source,
//!    which is bytes 32 to 64 of the source's data. The hook adds one to it.
//! 3. `treasury`, the address at byte 0 of the data of `config`, which is `Execute` account 5.

use anchor_v2_testing::Signer;
use solana_address::Address;

use super::{Chain, HOOK_PROGRAM_ID};

/// The first 8 bytes of SHA-256 of `spl-transfer-hook-interface:execute`.
const EXECUTE_DISCRIMINATOR: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];
const HOOK_PDA: u8 = 1;
const ADDRESS_IN_DATA: u8 = 2;

pub struct HookAccounts {
    pub meta_list: Address,
    pub counter: Address,
    pub treasury: Address,
}

/// Writes the meta list, `config`, and `counter` for `mint`, as the hook's owner would.
pub fn install(chain: &mut Chain, mint: &Address) -> Result<HookAccounts, String> {
    let (meta_list, _) = Address::find_program_address(&[b"extra-account-metas", mint.as_ref()], &HOOK_PROGRAM_ID);
    let (config, _) = Address::find_program_address(&[b"config"], &HOOK_PROGRAM_ID);
    let from = chain.wallets.from.pubkey();
    let (counter, _) = Address::find_program_address(&[b"counter", from.as_ref()], &HOOK_PROGRAM_ID);
    let treasury = Address::new_unique();

    let metas = [
        meta(HOOK_PDA, &[&[1, 6], &b"config"[..]].concat(), false),
        meta(HOOK_PDA, &[&[1, 7], &b"counter"[..], &[4, 0, 32, 32]].concat(), true),
        meta(ADDRESS_IN_DATA, &[2, 5, 0], false),
    ];
    let list = [&3u32.to_le_bytes()[..], &metas.concat()].concat();
    let list_len = u32::try_from(list.len()).map_err(|error| error.to_string())?;
    let meta_list_data = [&EXECUTE_DISCRIMINATOR[..], &list_len.to_le_bytes(), &list].concat();

    chain.set_account(meta_list, &HOOK_PROGRAM_ID, meta_list_data)?;
    chain.set_account(config, &HOOK_PROGRAM_ID, treasury.to_bytes().to_vec())?;
    chain.set_account(counter, &HOOK_PROGRAM_ID, vec![0; 8])?;

    Ok(HookAccounts { meta_list, counter, treasury })
}

/// A 35-byte `ExtraAccountMeta`: the discriminator, the 32-byte address config, and two flags.
fn meta(discriminator: u8, address_config: &[u8], is_writable: bool) -> Vec<u8> {
    let padding = vec![0; 32usize.saturating_sub(address_config.len())];

    [&[discriminator][..], address_config, &padding, &[0, u8::from(is_writable)]].concat()
}
