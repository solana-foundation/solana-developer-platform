//! A payload byte that its variant does not use must be zero, so that one record has one encoding.

use crate::SpecError;

pub(crate) fn require_zero(unused: &[u8]) -> Result<(), SpecError> {
    if unused.iter().any(|byte| *byte != 0) {
        return Err(SpecError::BadCode);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_any_nonzero_byte() {
        assert_eq!(require_zero(&[0, 0]), Ok(()));
        assert_eq!(require_zero(&[0, 1]), Err(SpecError::BadCode));
    }
}
