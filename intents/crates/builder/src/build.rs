use alloc::vec::Vec;

use bytemuck::bytes_of;
use pinocchio::account::AccountView;
use pinocchio::address::Address;
use pinocchio::cpi::set_return_data;
use sdp_intents_spec::builder::ResultKind;
use solana_instruction::syscalls::get_stack_height;

use crate::layout::{self, Section};
use crate::{BuildError, Meta};

/// The stack height of a top-level instruction. A builder runs there only in a simulation.
const TRANSACTION_LEVEL_STACK_HEIGHT: usize = 1;

/// The result of one builder instruction, as the handler adds to it.
pub struct Build<'a> {
    mode: Mode,
    /// The accounts that earlier `MoreAccounts` rounds asked for, after the implementation's accounts.
    extra_accounts: &'a [AccountView],
    returned: usize,
    requested: Vec<Address>,
    section: Section,
    outputs: Vec<u8>,
    bumps: Bumps<'a>,
}

/// The bumps of the builder's program addresses. A simulation finds each canonical bump and
/// returns it in the result. `verify_intent` states the bumps back, so each address derives with
/// one hash, and a bump that is missing, not canonical, or not used fails the builder.
enum Bumps<'a> {
    Found(Vec<u8>),
    Stated { bumps: &'a [u8], used: usize },
}

enum Mode {
    /// Scratch is account `scratch_index` of the instruction, its last.
    Staged {
        scratch: AccountView,
        scratch_index: u8,
    },
    Hashed,
}

impl<'a> Build<'a> {
    /// Reads the mode from the stack height. `implementation_accounts` is the number of accounts that the
    /// implementation names, which in Anchor v2 is `<T as TryAccounts>::HEADER_SIZE`. `accounts` are the ones
    /// after them: the extra accounts, then scratch in staged mode. `bumps` is the argument that the
    /// implementation passes as `{builder.bumps}`: empty in a simulation, and the bumps that the simulation
    /// found under `verify_intent`.
    pub fn new(
        program_id: &Address,
        implementation_accounts: usize,
        accounts: &'a [AccountView],
        bumps: &'a [u8],
    ) -> Result<Self, BuildError> {
        let (mode, extra_accounts) = if get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT {
            let (scratch, extra_accounts) = accounts.split_last().ok_or(BuildError::NoScratch)?;

            if !scratch.owned_by(program_id) || !scratch.is_writable() {
                return Err(BuildError::NoScratch);
            }

            let scratch_index =
                implementation_accounts.checked_add(extra_accounts.len()).ok_or(BuildError::TooLarge)?;
            let scratch_index = u8::try_from(scratch_index).map_err(|_| BuildError::TooLarge)?;

            (Mode::Staged { scratch: *scratch, scratch_index }, extra_accounts)
        } else {
            (Mode::Hashed, accounts)
        };

        let bumps = match mode {
            Mode::Staged { .. } if !bumps.is_empty() => return Err(BuildError::WrongBumps),
            Mode::Staged { .. } => Bumps::Found(Vec::new()),
            Mode::Hashed => Bumps::Stated { bumps, used: 0 },
        };

        Ok(Self {
            mode,
            extra_accounts,
            returned: 0,
            requested: Vec::new(),
            section: Section::default(),
            outputs: Vec::new(),
            bumps,
        })
    }

    /// The program address of `seeds` under `program`. A simulation searches for the canonical
    /// bump. Under `verify_intent` the next stated bump derives it with one hash, and fails unless
    /// it is canonical.
    pub fn program_address(&mut self, seeds: &[&[u8]], program: &Address) -> Result<Address, BuildError> {
        match &mut self.bumps {
            Bumps::Found(found) => {
                let (address, bump) =
                    Address::try_find_program_address(seeds, program).ok_or(BuildError::WrongAccounts)?;
                found.push(bump);

                Ok(address)
            }
            Bumps::Stated { bumps, used } => {
                let bump = *bumps.get(*used).ok_or(BuildError::WrongBumps)?;
                let program = sdp_intents_spec::Address(program.to_bytes());
                let address =
                    sdp_intents_engine::program_address(seeds, bump, &program).ok_or(BuildError::WrongBumps)?;
                *used = used.saturating_add(1);

                Ok(Address::new_from_array(address.0))
            }
        }
    }

    /// The accounts at `addresses`, in order, when the caller passed them after the ones that earlier
    /// calls returned. `None` means that the caller did not pass them: the handler then returns
    /// `finish()`, which asks for them with `MoreAccounts`. In hashed mode that is an error.
    pub fn require_accounts(&mut self, addresses: &[Address]) -> Result<Option<&'a [AccountView]>, BuildError> {
        let rest = self.extra_accounts.get(self.returned..).unwrap_or_default();

        if addresses.is_empty() {
            return Ok(Some(&[]));
        }

        if rest.is_empty() {
            if matches!(self.mode, Mode::Hashed) {
                return Err(BuildError::MissingAccounts);
            }

            self.requested.extend_from_slice(addresses);
            return Ok(None);
        }

        let given = rest.get(..addresses.len()).ok_or(BuildError::WrongAccounts)?;

        if given.iter().zip(addresses).any(|(account, address)| account.address() != address) {
            return Err(BuildError::WrongAccounts);
        }

        self.returned = self.returned.saturating_add(addresses.len());

        Ok(Some(given))
    }

    pub fn instruction(&mut self, program: &Address, accounts: &[Meta], data: &[u8]) -> Result<(), BuildError> {
        if !self.requested.is_empty() {
            return Err(BuildError::AfterRequest);
        }

        self.section.push(program, accounts, data)
    }

    /// Adds to the interface's outputs, which the builder writes in order, in borsh.
    pub fn output(&mut self, bytes: &[u8]) {
        self.outputs.extend_from_slice(bytes);
    }

    /// Writes `MoreAccounts` when the builder asked for accounts, and the instructions otherwise.
    pub fn finish(self) -> Result<(), BuildError> {
        let found = match &self.bumps {
            Bumps::Found(found) => found.as_slice(),
            Bumps::Stated { bumps, used } if *used == bumps.len() => &[],
            Bumps::Stated { .. } => return Err(BuildError::WrongBumps),
        };

        match self.mode {
            Mode::Staged { scratch, scratch_index } if self.requested.is_empty() => {
                let ready = layout::ready(&self.section, &self.outputs, found)?;

                write_staged(scratch, scratch_index, ResultKind::Ready, &ready)
            }
            Mode::Staged { scratch, scratch_index } => {
                write_staged(scratch, scratch_index, ResultKind::MoreAccounts, &layout::more_accounts(&self.requested)?)
            }
            Mode::Hashed => {
                set_return_data(&layout::hashed(&self.section, &self.outputs)?);
                Ok(())
            }
        }
    }

    /// A precondition that does not hold, such as `vaultPaused`. In hashed mode it fails the
    /// instruction, because the state changed since the simulation.
    pub fn refuse(self, code: &str, message: &str) -> Result<(), BuildError> {
        match self.mode {
            Mode::Staged { scratch, scratch_index } => {
                write_staged(scratch, scratch_index, ResultKind::Refused, &layout::refused(code, message)?)
            }
            Mode::Hashed => Err(BuildError::Refused),
        }
    }
}

fn write_staged(
    mut scratch: AccountView,
    scratch_index: u8,
    kind: ResultKind,
    result: &[u8],
) -> Result<(), BuildError> {
    let pointer = layout::pointer(kind, scratch_index, result.len())?;
    let mut data = scratch.try_borrow_mut().map_err(|_| BuildError::ScratchBorrowed)?;
    data.get_mut(..result.len()).ok_or(BuildError::TooLarge)?.copy_from_slice(result);
    drop(data);

    set_return_data(bytes_of(&pointer));

    Ok(())
}
