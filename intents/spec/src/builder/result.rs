//! Views of the builder results. Each `parse` checks the whole layout once, so a result that parses
//! has no byte that its fields do not account for.

use super::wire::{AccountMetaV1, HashedReadyV1, InstructionHeaderV1, ReadyHeaderV1, ResultKind, ResultPointerV1};
use crate::region::Cursor;
use crate::{AccountRole, Address, PodU16, SpecError};

/// The result of a builder at stack height 1, which the service's simulation reads from scratch.
#[derive(Clone, Copy)]
pub enum StagedResult<'a> {
    Ready(Ready<'a>),
    MoreAccounts(&'a [Address]),
    Refused(Refused<'a>),
}

impl<'a> StagedResult<'a> {
    /// `return_data` holds the `ResultPointerV1`, and `scratch` is the data of the scratch account.
    pub fn parse(return_data: &[u8], scratch: &'a [u8]) -> Result<Self, SpecError> {
        let mut pointer_cursor = Cursor::new(return_data);
        let pointer: &ResultPointerV1 = pointer_cursor.fixed()?;
        pointer_cursor.finish()?;

        let offset = usize::try_from(pointer.offset.get()).map_err(|_| SpecError::OutOfBounds)?;
        let len = usize::try_from(pointer.len.get()).map_err(|_| SpecError::OutOfBounds)?;
        let end = offset.checked_add(len).ok_or(SpecError::OutOfBounds)?;
        let bytes = scratch.get(offset..end).ok_or(SpecError::OutOfBounds)?;

        match ResultKind::try_from(pointer.kind)? {
            ResultKind::Ready => Ready::parse(bytes).map(Self::Ready),
            ResultKind::MoreAccounts => more_accounts(bytes).map(Self::MoreAccounts),
            ResultKind::Refused => Refused::parse(bytes).map(Self::Refused),
            ResultKind::HashedReady => Err(SpecError::WrongKind),
        }
    }
}

fn more_accounts(bytes: &[u8]) -> Result<&[Address], SpecError> {
    let mut cursor = Cursor::new(bytes);
    let [count] = *cursor.fixed::<[u8; 1]>()?;
    let addresses = cursor.entries(usize::from(count))?;
    cursor.finish()?;

    Ok(addresses)
}

#[derive(Clone, Copy, Debug)]
pub struct Refused<'a> {
    pub code: &'a [u8],
    pub message: &'a [u8],
}

impl<'a> Refused<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, SpecError> {
        let mut cursor = Cursor::new(bytes);
        let [code_len] = *cursor.fixed::<[u8; 1]>()?;
        let message_len = cursor.fixed::<PodU16>()?.get();
        let code = cursor.take(usize::from(code_len))?;
        let message = cursor.take(usize::from(message_len))?;
        cursor.finish()?;

        Ok(Self { code, message })
    }
}

/// A `Ready` result: the outputs, the signers, and the instruction section.
#[derive(Clone, Copy)]
pub struct Ready<'a> {
    header: &'a ReadyHeaderV1,
    rest: &'a [u8],
}

impl<'a> Ready<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, SpecError> {
        let mut cursor = Cursor::new(bytes);
        let ready = Self { header: cursor.fixed()?, rest: cursor.rest() };

        ready
            .instructions()?
            .try_for_each(|instruction| instruction.and_then(|instruction| instruction.check_roles()))?;
        ready.instructions()?.end()?;

        Ok(ready)
    }

    /// The interface's outputs, in order, in borsh.
    pub fn outputs(&self) -> Result<&'a [u8], SpecError> {
        Cursor::new(self.rest).take(usize::from(self.header.outputs_len.get()))
    }

    pub fn signers(&self) -> Result<&'a [Address], SpecError> {
        let mut cursor = Cursor::new(self.rest);
        cursor.take(usize::from(self.header.outputs_len.get()))?;

        cursor.entries(usize::from(self.header.num_signers))
    }

    /// The bytes that `HashedReadyV1::instructions_hash` covers.
    pub fn instruction_section(&self) -> Result<&'a [u8], SpecError> {
        let mut cursor = Cursor::new(self.rest);
        cursor.take(usize::from(self.header.outputs_len.get()))?;
        cursor.entries::<Address>(usize::from(self.header.num_signers))?;

        Ok(cursor.rest())
    }

    pub fn instructions(&self) -> Result<ReadyInstructions<'a>, SpecError> {
        Ok(ReadyInstructions::new(self.instruction_section()?, self.header.num_instructions))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ReadyInstruction<'a> {
    pub program: &'a Address,
    pub accounts: &'a [AccountMetaV1],
    pub data: &'a [u8],
}

impl ReadyInstruction<'_> {
    fn check_roles(&self) -> Result<(), SpecError> {
        self.accounts.iter().try_for_each(|account| account.role().map(|_| ()))
    }
}

impl AccountMetaV1 {
    pub fn role(&self) -> Result<AccountRole, SpecError> {
        AccountRole::try_from(self.role)
    }
}

/// The instructions of an instruction section, in order. After an error it yields nothing more.
#[derive(Clone, Copy)]
pub struct ReadyInstructions<'a> {
    cursor: Cursor<'a>,
    remaining: u8,
}

impl<'a> ReadyInstructions<'a> {
    pub fn new(section: &'a [u8], num_instructions: u8) -> Self {
        Self { cursor: Cursor::new(section), remaining: num_instructions }
    }

    /// Reads every instruction, and checks that the section holds nothing after the last one.
    pub fn end(mut self) -> Result<(), SpecError> {
        self.try_for_each(|instruction| instruction.map(|_| ()))?;

        self.cursor.finish()
    }

    fn read(&mut self) -> Result<ReadyInstruction<'a>, SpecError> {
        let header: &InstructionHeaderV1 = self.cursor.fixed()?;
        let accounts = self.cursor.entries(usize::from(header.num_accounts))?;
        let data = self.cursor.take(usize::from(header.data_len.get()))?;

        Ok(ReadyInstruction { program: &header.program, accounts, data })
    }
}

impl<'a> Iterator for ReadyInstructions<'a> {
    type Item = Result<ReadyInstruction<'a>, SpecError>;

    fn next(&mut self) -> Option<Self::Item> {
        self.remaining = self.remaining.checked_sub(1)?;
        let instruction = self.read();

        if instruction.is_err() {
            self.remaining = 0;
        }

        Some(instruction)
    }
}

/// The return data of a builder under CPI.
#[derive(Clone, Copy)]
pub struct HashedReady<'a> {
    pub fixed: &'a HashedReadyV1,
    pub signers: &'a [Address],
    pub outputs: &'a [u8],
}

impl<'a> HashedReady<'a> {
    pub fn parse(return_data: &'a [u8]) -> Result<Self, SpecError> {
        let mut cursor = Cursor::new(return_data);
        let fixed: &HashedReadyV1 = cursor.fixed()?;

        if ResultKind::try_from(fixed.kind)? != ResultKind::HashedReady {
            return Err(SpecError::WrongKind);
        }

        let signers = cursor.entries(usize::from(fixed.num_signers))?;
        let outputs = cursor.take(usize::from(fixed.outputs_len.get()))?;
        cursor.finish()?;

        Ok(Self { fixed, signers, outputs })
    }
}

#[cfg(test)]
mod tests {
    use bytemuck::bytes_of;

    use super::*;
    use crate::PodU32;

    fn instruction(program: u8, accounts: &[(u8, u8)], data: &[u8]) -> Vec<u8> {
        let header = InstructionHeaderV1 {
            program: Address([program; 32]),
            num_accounts: u8::try_from(accounts.len()).unwrap(),
            data_len: PodU16::new(u16::try_from(data.len()).unwrap()),
        };

        let metas = accounts.iter().flat_map(|(address, role)| {
            bytes_of(&AccountMetaV1 { address: Address([*address; 32]), role: *role }).to_vec()
        });

        bytes_of(&header).iter().copied().chain(metas).chain(data.iter().copied()).collect()
    }

    fn ready(section: &[u8], num_instructions: u8) -> Vec<u8> {
        let header = ReadyHeaderV1 { num_instructions, num_signers: 1, outputs_len: PodU16::new(2) };

        [bytes_of(&header), &[7, 7], &[5; 32], section].concat()
    }

    #[test]
    fn reads_a_ready_result_in_place() {
        let section = [instruction(1, &[(2, 1), (3, 2)], &[12, 0]), instruction(4, &[], &[1])].concat();
        let bytes = ready(&section, 2);
        let ready = Ready::parse(&bytes).unwrap();

        assert_eq!(ready.outputs().unwrap(), [7, 7]);
        assert_eq!(ready.signers().unwrap(), [Address([5; 32])]);
        assert_eq!(ready.instruction_section().unwrap(), section.as_slice());

        let first = ready.instructions().unwrap().next().unwrap().unwrap();
        assert_eq!(first.program, &Address([1; 32]));
        assert_eq!(first.accounts.get(1).unwrap().role(), Ok(AccountRole::ReadonlySigner));
        assert_eq!(first.data, [12, 0]);
        assert_eq!(ready.instructions().unwrap().count(), 2);
    }

    #[test]
    fn refuses_bytes_after_the_last_instruction_and_a_bad_role() {
        let section = instruction(1, &[(2, 1)], &[]);

        assert_eq!(
            Ready::parse(&ready(&[section.as_slice(), &[0]].concat(), 1)).err(),
            Some(SpecError::LengthMismatch)
        );

        assert_eq!(Ready::parse(&ready(&instruction(1, &[(2, 4)], &[]), 1)).err(), Some(SpecError::BadCode));
        assert_eq!(Ready::parse(&ready(&section, 2)).err(), Some(SpecError::Truncated));
    }

    #[test]
    fn a_staged_result_follows_its_pointer_into_scratch() {
        let refused = [&[6u8][..], &PodU16::new(12).0, b"paused", b"vault paused"].concat();
        let scratch = [&[0u8; 4][..], &refused].concat();
        let pointer = ResultPointerV1 {
            kind: ResultKind::Refused.into(),
            account_index: 5,
            offset: PodU32::new(4),
            len: PodU32::new(u32::try_from(refused.len()).unwrap()),
        };

        let Ok(StagedResult::Refused(result)) = StagedResult::parse(bytes_of(&pointer), &scratch) else {
            panic!("the result is not a refusal");
        };

        assert_eq!(result.code, b"paused");
        assert_eq!(result.message, b"vault paused");
    }

    #[test]
    fn reads_more_accounts_and_a_hashed_result() {
        let more = [&[2u8][..], &[1; 32], &[2; 32]].concat();
        let pointer = ResultPointerV1 {
            kind: ResultKind::MoreAccounts.into(),
            account_index: 0,
            offset: PodU32::new(0),
            len: PodU32::new(65),
        };

        let Ok(StagedResult::MoreAccounts(addresses)) = StagedResult::parse(bytes_of(&pointer), &more) else {
            panic!("the result is not a request for accounts");
        };

        assert_eq!(addresses, [Address([1; 32]), Address([2; 32])]);

        let fixed = HashedReadyV1 {
            kind: ResultKind::HashedReady.into(),
            instructions_hash: [8; 32],
            num_signers: 0,
            outputs_len: PodU16::new(1),
        };

        let hashed_bytes = [bytes_of(&fixed), &[4]].concat();
        let hashed = HashedReady::parse(&hashed_bytes).unwrap();
        assert_eq!(hashed.outputs, [4]);
        assert_eq!(hashed.fixed.instructions_hash, [8; 32]);
    }
}
