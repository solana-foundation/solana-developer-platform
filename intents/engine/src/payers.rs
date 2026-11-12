use sdp_intents_spec::builder::PAYER_RENT_PLACEHOLDER;
use sdp_intents_spec::Address;

/// The fee payer and the rent payer of an intent. A builder never sees them. It names the rent payer
/// with a placeholder, and never names the fee payer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Payers<'a> {
    pub fee: &'a Address,
    pub rent: &'a Address,
}

impl<'a> Payers<'a> {
    /// The rent payer for the placeholder, or the address itself for any other address.
    pub fn replace_placeholder<'b>(&self, address: &'b Address) -> &'b Address
    where
        'a: 'b,
    {
        if *address == PAYER_RENT_PLACEHOLDER {
            return self.rent;
        }

        address
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_placeholder_to_the_rent_payer() {
        let fee = Address([1; 32]);
        let rent = Address([2; 32]);
        let payers = Payers { fee: &fee, rent: &rent };

        assert_eq!(payers.replace_placeholder(&PAYER_RENT_PLACEHOLDER), &rent);
        assert_eq!(payers.replace_placeholder(&fee), &fee);
    }
}
