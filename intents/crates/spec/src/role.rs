use crate::code::wire_code;

wire_code! {
    /// The numeric `AccountRole` of an account in an instruction.
    pub enum AccountRole {
        Readonly = 0,
        Writable = 1,
        ReadonlySigner = 2,
        WritableSigner = 3,
    }
}

impl AccountRole {
    pub fn new(writable: bool, signer: bool) -> Self {
        match (writable, signer) {
            (false, false) => Self::Readonly,
            (true, false) => Self::Writable,
            (false, true) => Self::ReadonlySigner,
            (true, true) => Self::WritableSigner,
        }
    }

    pub fn writable(self) -> bool {
        matches!(self, Self::Writable | Self::WritableSigner)
    }

    pub fn signer(self) -> bool {
        matches!(self, Self::ReadonlySigner | Self::WritableSigner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_role_is_its_two_flags() {
        assert_eq!(u8::from(AccountRole::new(true, true)), 3);
        assert_eq!(u8::from(AccountRole::new(false, true)), 2);
        assert!(AccountRole::Writable.writable() && !AccountRole::Writable.signer());
    }
}
