use anchor_lang::prelude::*;

use crate::error::RegistryError;

pub const MAX_ORGANIZATION_NAME: usize = 64;

/// An organization, such as `solana.org`. Its address is the PDA of `"org"` and the SHA-256 of the
/// name, so each name has one organization. Documents name it as their `publisher`.
#[account]
pub struct OrganizationV1 {
    pub authority: Address,
    pub name_hash: [u8; 32],
    pub name_len: u8,
    pub name: [u8; MAX_ORGANIZATION_NAME],
}

impl OrganizationV1 {
    /// The authority that `stored` names. `Address::default()` names the organization authority,
    /// so an index follows a change of it.
    pub fn resolve<'a>(&'a self, stored: &'a Address) -> &'a Address {
        if *stored == Address::default() {
            return &self.authority;
        }

        stored
    }

    pub fn require_authority(&self, stored: &Address, signer: &Signer) -> Result<()> {
        require!(signer.address() == self.resolve(stored), RegistryError::WrongAuthority);

        Ok(())
    }
}

/// A name holds 1 to 64 letters, digits, `.`, `-`, and `_`, as the compiler requires of the
/// organization part of an id.
pub fn check_name(name: &[u8]) -> Result<()> {
    let valid_character = |byte: &u8| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_');

    require!(
        !name.is_empty() && name.len() <= MAX_ORGANIZATION_NAME && name.iter().all(valid_character),
        RegistryError::BadName
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_pinned() {
        assert_eq!(core::mem::size_of::<OrganizationV1>(), 129);
    }

    #[test]
    fn a_name_is_an_id_part() {
        assert!(check_name(b"solana.org").is_ok());
        assert!(check_name(b"").is_err());
        assert!(check_name(b"solana org").is_err());
        assert!(check_name(&[b'a'; 65]).is_err());
    }
}
