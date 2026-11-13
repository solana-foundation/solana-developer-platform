use anchor_lang::prelude::*;

use crate::error::RegistryError;
use crate::state::buffer::{BufferV1, FIXED_LEN, MAX_DOCUMENT_LEN};
use crate::state::wire::PodU16;
use crate::state::{close, owned_data, owned_data_mut, BUFFER_SEED};

/// The first write creates the buffer at the size of the whole document, and the writer pays its
/// rent. Each later write must come from the same writer and name the same length.
#[derive(Accounts)]
// Anchor's exit hook binds the argument and does not read it. The underscore keeps that from a
// warning.
#[instruction(_buffer_id: u32)]
pub struct WriteBuffer {
    #[account(mut)]
    pub writer: Signer,
    #[account(mut, seeds = [BUFFER_SEED, writer.address().as_ref(), &_buffer_id.to_le_bytes()], bump)]
    pub buffer: UncheckedAccount,
    pub system_program: Program<System>,
}

/// Where a part goes in the document, and its bytes.
pub struct BufferPart<'a> {
    pub document_len: u16,
    pub offset: u16,
    pub bytes: &'a [u8],
}

impl WriteBuffer {
    pub fn write(&mut self, buffer_id: u32, part: BufferPart<'_>, bump: u8) -> Result<()> {
        if self.buffer.account().data_len() == 0 {
            self.create(buffer_id, part.document_len, bump)?;
        }

        let mut view = *self.buffer.account();
        let mut data = owned_data_mut(&mut view, BufferV1::DISCRIMINATOR)?;
        let header: &BufferV1 = bytemuck::try_from_bytes(data.get(8..FIXED_LEN).ok_or(RegistryError::WrongAccount)?)
            .map_err(|_| RegistryError::WrongAccount)?;

        require!(
            header.authority == *self.writer.address() && header.document_len.get() == part.document_len,
            RegistryError::WrongBuffer
        );

        let start = FIXED_LEN.checked_add(usize::from(part.offset)).ok_or(ProgramError::ArithmeticOverflow)?;
        let end = start.checked_add(part.bytes.len()).ok_or(ProgramError::ArithmeticOverflow)?;
        data.get_mut(start..end).ok_or(RegistryError::OutOfBuffer)?.copy_from_slice(part.bytes);

        Ok(())
    }

    fn create(&self, buffer_id: u32, document_len: u16, bump: u8) -> Result<()> {
        require!(usize::from(document_len) <= MAX_DOCUMENT_LEN, RegistryError::DocumentTooLarge);

        let space = FIXED_LEN.checked_add(usize::from(document_len)).ok_or(ProgramError::ArithmeticOverflow)?;
        let buffer_id = buffer_id.to_le_bytes();
        let seeds: [&[u8]; 4] = [BUFFER_SEED, self.writer.address().as_ref(), &buffer_id, &[bump]];
        anchor_lang::create_account_signed(self.writer.account(), self.buffer.account(), space, &crate::ID, &seeds)?;

        let header = BufferV1 { authority: *self.writer.address(), document_len: PodU16::from(document_len) };
        let mut view = *self.buffer.account();
        let mut data = view.try_borrow_mut()?;
        data.get_mut(..8).ok_or(RegistryError::WrongAccount)?.copy_from_slice(BufferV1::DISCRIMINATOR);
        data.get_mut(8..FIXED_LEN).ok_or(RegistryError::WrongAccount)?.copy_from_slice(bytemuck::bytes_of(&header));

        Ok(())
    }
}

/// Returns the rent of a buffer that its writer does not publish.
#[derive(Accounts)]
pub struct CloseBuffer {
    #[account(mut)]
    pub writer: Signer,
    #[account(mut)]
    pub buffer: UncheckedAccount,
}

impl CloseBuffer {
    pub fn close(&mut self) -> Result<()> {
        require!(buffer_authority(self.buffer.account())? == *self.writer.address(), RegistryError::WrongBuffer);

        let mut buffer = *self.buffer.account();
        let mut writer = *self.writer.account();

        close(&mut buffer, &mut writer)
    }
}

/// The key that wrote a buffer.
pub fn buffer_authority(view: &AccountView) -> Result<Address> {
    let data = owned_data(view, BufferV1::DISCRIMINATOR)?;
    let header: &BufferV1 = bytemuck::try_from_bytes(data.get(8..FIXED_LEN).ok_or(RegistryError::WrongAccount)?)
        .map_err(|_| RegistryError::WrongAccount)?;

    Ok(header.authority)
}
