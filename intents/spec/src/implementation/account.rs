use super::payload::require_zero;
use super::wire::{AccountSourceKind, AccountV1, ACCOUNT_SIGNER, ACCOUNT_WRITABLE};
use crate::{PoolRefV1, RangeV1, SpecError, ValueRef};

/// Where an account's address comes from. Indexes name entries of the record's tables.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressSource {
    Value(ValueRef),
    Static {
        address: u8,
    },
    Pda {
        program: ValueRef,
        seeds: RangeV1,
    },
    Ata {
        owner: ValueRef,
        mint: ValueRef,
        token_program: ValueRef,
    },
    /// The 32 bytes at `offset` in an earlier account, which `owner` must own.
    HasOne {
        account: u8,
        owner: u8,
        offset: u16,
    },
}

impl AccountV1 {
    /// Encodes an account. `address` decodes back to the same `AddressSource`.
    pub fn new(name: PoolRefV1, writable: bool, signer: bool, address: AddressSource) -> Self {
        let flags = if writable { ACCOUNT_WRITABLE } else { 0 } | if signer { ACCOUNT_SIGNER } else { 0 };
        let (source, payload) = match address {
            AddressSource::Value(value) => {
                let [a, b] = value.to_bytes();
                (AccountSourceKind::Value, [a, b, 0, 0, 0, 0])
            }
            AddressSource::Static { address } => (AccountSourceKind::Static, [address, 0, 0, 0, 0, 0]),
            AddressSource::Pda { program, seeds } => {
                let [a, b] = program.to_bytes();
                (AccountSourceKind::Pda, [a, b, seeds.first, seeds.count, 0, 0])
            }
            AddressSource::Ata { owner, mint, token_program } => {
                let [a, b] = owner.to_bytes();
                let [c, d] = mint.to_bytes();
                let [e, f] = token_program.to_bytes();
                (AccountSourceKind::Ata, [a, b, c, d, e, f])
            }
            AddressSource::HasOne { account, owner, offset } => {
                let [c, d] = offset.to_le_bytes();
                (AccountSourceKind::HasOne, [account, owner, c, d, 0, 0])
            }
        };

        Self { name, flags, source: source.into(), payload }
    }

    pub fn writable(&self) -> bool {
        self.flags & ACCOUNT_WRITABLE != 0
    }

    pub fn signer(&self) -> bool {
        self.flags & ACCOUNT_SIGNER != 0
    }

    pub fn address(&self) -> Result<AddressSource, SpecError> {
        let [a, b, c, d, e, f] = self.payload;

        match AccountSourceKind::try_from(self.source)? {
            AccountSourceKind::Value => {
                require_zero(&[c, d, e, f])?;

                Ok(AddressSource::Value(ValueRef::from_bytes([a, b])?))
            }
            AccountSourceKind::Static => {
                require_zero(&[b, c, d, e, f])?;

                Ok(AddressSource::Static { address: a })
            }
            AccountSourceKind::Pda => {
                require_zero(&[e, f])?;

                Ok(AddressSource::Pda { program: ValueRef::from_bytes([a, b])?, seeds: RangeV1 { first: c, count: d } })
            }
            AccountSourceKind::Ata => Ok(AddressSource::Ata {
                owner: ValueRef::from_bytes([a, b])?,
                mint: ValueRef::from_bytes([c, d])?,
                token_program: ValueRef::from_bytes([e, f])?,
            }),
            AccountSourceKind::HasOne => {
                require_zero(&[e, f])?;

                Ok(AddressSource::HasOne { account: a, owner: b, offset: u16::from_le_bytes([c, d]) })
            }
        }
    }

    pub(crate) fn check_flags(&self) -> Result<(), SpecError> {
        if self.flags & !(ACCOUNT_WRITABLE | ACCOUNT_SIGNER) != 0 {
            return Err(SpecError::BadCode);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ValueSource;

    fn decode(source: AccountSourceKind, payload: [u8; 6]) -> Result<AddressSource, SpecError> {
        AccountV1 { name: PoolRefV1::default(), flags: 0, source: source.into(), payload }.address()
    }

    fn input(index: u8) -> ValueRef {
        ValueRef { source: ValueSource::Input, index }
    }

    #[test]
    fn decodes_each_source() {
        assert_eq!(decode(AccountSourceKind::Value, [1, 3, 0, 0, 0, 0]), Ok(AddressSource::Value(input(3))));
        assert_eq!(decode(AccountSourceKind::Static, [2, 0, 0, 0, 0, 0]), Ok(AddressSource::Static { address: 2 }));
        assert_eq!(
            decode(AccountSourceKind::Ata, [1, 0, 1, 2, 5, 1]),
            Ok(AddressSource::Ata {
                owner: input(0),
                mint: input(2),
                token_program: ValueRef { source: ValueSource::Address, index: 1 }
            })
        );
        assert_eq!(
            decode(AccountSourceKind::HasOne, [1, 0, 8, 0, 0, 0]),
            Ok(AddressSource::HasOne { account: 1, owner: 0, offset: 8 })
        );
    }

    #[test]
    fn refuses_unknown_sources_and_stray_payload_bytes() {
        let unknown = AccountV1 { source: 9, ..AccountV1::default() };

        assert_eq!(unknown.address(), Err(SpecError::BadCode));
        assert_eq!(decode(AccountSourceKind::Static, [2, 0, 0, 0, 0, 7]), Err(SpecError::BadCode));
    }

    #[test]
    fn encoding_then_decoding_gives_the_same_source() {
        let sources = [
            AddressSource::Value(input(4)),
            AddressSource::Static { address: 7 },
            AddressSource::Pda { program: input(1), seeds: RangeV1 { first: 2, count: 3 } },
            AddressSource::Ata { owner: input(0), mint: input(2), token_program: input(5) },
            AddressSource::HasOne { account: 1, owner: 0, offset: 300 },
        ];

        sources.into_iter().for_each(|source| {
            let account = AccountV1::new(PoolRefV1::default(), true, false, source);

            assert_eq!(account.address(), Ok(source));
            assert!(account.writable() && !account.signer());
        });
    }

    #[test]
    fn decoded_source_fits_in_a_register_pair() {
        assert!(core::mem::size_of::<AddressSource>() <= 8);
    }
}
