//! A Token-2022 transfer hook for the tests of `token-2022-builder`. Its only instruction is the
//! transfer hook interface's `Execute`, which adds one to the counter at [`COUNTER_INDEX`]. A test
//! names the counter in the extra account meta list, so a counter of one shows that Token-2022 found
//! every extra account and passed the counter writable.
//!
//! The program has no instruction that writes the meta list. A test writes the account directly.

#![no_std]

use pinocchio::account::AccountView;
use pinocchio::address::Address;
use pinocchio::error::ProgramError;
use pinocchio::ProgramResult;

pinocchio::program_entrypoint!(process_instruction);
pinocchio::no_allocator!();
pinocchio::nostd_panic_handler!();

pub const ID: Address = Address::from_str_const("9dRuqr7dtKTnPJacira1fasr8q7HddDhPfzf2jGAuvQv");

/// The first 8 bytes of SHA-256 of `spl-transfer-hook-interface:execute`.
pub const EXECUTE_DISCRIMINATOR: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];

/// The source, the mint, the destination, the authority, and the meta list come first. The
/// counter is the second extra account.
pub const COUNTER_INDEX: usize = 6;

fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if data.get(..EXECUTE_DISCRIMINATOR.len()) != Some(&EXECUTE_DISCRIMINATOR[..]) {
        return Err(ProgramError::InvalidInstructionData);
    }

    let counter = accounts.get_mut(COUNTER_INDEX).ok_or(ProgramError::NotEnoughAccountKeys)?;

    if !counter.owned_by(program_id) || !counter.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    let mut counter_data = counter.try_borrow_mut()?;
    let count = counter_data.first_chunk_mut::<8>().ok_or(ProgramError::AccountDataTooSmall)?;
    *count = u64::from_le_bytes(*count).saturating_add(1).to_le_bytes();

    Ok(())
}
