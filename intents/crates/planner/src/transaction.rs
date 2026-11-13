use sdp_intents_spec::Address;

use crate::{Instruction, Limit, PlanError};

/// The runtime charges 5,000 lamports for each signature.
const SIGNATURE_FEE: u64 = 5_000;
const MAX_COMPUTE_UNITS: u32 = 1_400_000;
const MIN_HEAP_SIZE: u32 = 32 * 1024;
/// The runtime locks at most 64 accounts, and runs at most 64 top-level instructions.
const MAX_ACCOUNTS: usize = 64;
const MAX_INSTRUCTIONS: usize = 64;

/// A v1 transaction before its blockhash and its signatures. The caller compiles it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transaction {
    pub fee_payer: Address,
    pub instructions: Vec<Instruction>,
    pub budget: Budget,
    /// The total priority fee, which the v1 header holds.
    pub priority_fee_lamports: u64,
}

/// The compute budget in the v1 header. Its limits default to zero, so every transaction sets them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    pub compute_unit_limit: u32,
    pub loaded_accounts_data_size_limit: u32,
    pub heap_size: u32,
}

impl Budget {
    /// The highest limits, so that a simulation measures what the transaction uses.
    pub const MAXIMUM: Self = Self {
        compute_unit_limit: MAX_COMPUTE_UNITS,
        loaded_accounts_data_size_limit: 64 * 1024 * 1024,
        heap_size: 256 * 1024,
    };

    /// What a simulation used, with a tenth more, because state can change before the transaction
    /// lands. The final transaction runs no builder, so it needs the smallest heap.
    pub(crate) fn measured(units_consumed: u64, loaded_accounts_data_size: Option<u32>) -> Self {
        let with_margin = |used: u64| used.saturating_add(used / 10);
        let units = u32::try_from(with_margin(units_consumed)).unwrap_or(MAX_COMPUTE_UNITS).min(MAX_COMPUTE_UNITS);
        let loaded = loaded_accounts_data_size.map_or(Self::MAXIMUM.loaded_accounts_data_size_limit, |size| {
            u32::try_from(with_margin(u64::from(size))).unwrap_or(Self::MAXIMUM.loaded_accounts_data_size_limit)
        });

        Self { compute_unit_limit: units, loaded_accounts_data_size_limit: loaded, heap_size: MIN_HEAP_SIZE }
    }
}

impl Transaction {
    /// A transaction for a simulation: the highest budget, and no priority fee.
    pub(crate) fn unbudgeted(fee_payer: Address, instructions: Vec<Instruction>) -> Self {
        Self { fee_payer, instructions, budget: Budget::MAXIMUM, priority_fee_lamports: 0 }
    }

    /// Fails when the runtime would refuse the transaction for its accounts or its instructions.
    /// The caller checks the size after it compiles the message.
    pub(crate) fn check_fit(&self) -> Result<(), PlanError> {
        let fits = |limit: Limit, used: usize, max: usize| {
            if used > max {
                return Err(PlanError::DoesNotFit { limit, used, max });
            }

            Ok(())
        };

        fits(Limit::Accounts, self.accounts().len(), MAX_ACCOUNTS)?;
        fits(Limit::Instructions, self.instructions.len(), MAX_INSTRUCTIONS)
    }

    /// Every account that the transaction names, the fee payer first, each once.
    pub fn accounts(&self) -> Vec<Address> {
        let named = self.instructions.iter().flat_map(|instruction| {
            core::iter::once(instruction.program).chain(instruction.accounts.iter().map(|meta| meta.address))
        });

        unique(core::iter::once(self.fee_payer).chain(named))
    }

    /// The fee payer, then every account that an instruction can write, each once. Only these can
    /// change.
    pub fn writable_accounts(&self) -> Vec<Address> {
        let writable = self.instructions.iter().flat_map(|instruction| {
            instruction.accounts.iter().filter(|meta| meta.role.writable()).map(|meta| meta.address)
        });

        unique(core::iter::once(self.fee_payer).chain(writable))
    }

    /// The fee payer, then every other account that an instruction names as a signer, each once.
    pub fn signers(&self) -> Vec<Address> {
        let signers = self.instructions.iter().flat_map(|instruction| {
            instruction.accounts.iter().filter(|meta| meta.role.signer()).map(|meta| meta.address)
        });

        unique(core::iter::once(self.fee_payer).chain(signers))
    }

    pub(crate) fn fee(&self) -> u64 {
        let signatures = u64::try_from(self.signers().len()).unwrap_or(u64::MAX);

        SIGNATURE_FEE.saturating_mul(signatures).saturating_add(self.priority_fee_lamports)
    }
}

fn unique(addresses: impl Iterator<Item = Address>) -> Vec<Address> {
    addresses.fold(Vec::new(), |mut unique, address| {
        if !unique.contains(&address) {
            unique.push(address);
        }

        unique
    })
}

/// A signature that the plan needs, and why the address signs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequiredSignature {
    pub address: Address,
    pub role: SignerRole,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignerRole {
    FeePayer,
    RentPayer,
    /// A signer input of the interface, by name.
    Input(String),
    /// A new account that a builder asked the plan's signer to sign for.
    Builder,
    /// An account that the provider of a remote transaction signed for already.
    Provider,
}

impl SignerRole {
    /// The role as the plan JSON writes it: `payer:fee`, `payer:rent`, `input:<name>`, or `builder`.
    pub fn as_text(&self) -> String {
        match self {
            Self::FeePayer => "payer:fee".to_owned(),
            Self::RentPayer => "payer:rent".to_owned(),
            Self::Input(name) => format!("input:{name}"),
            Self::Builder => "builder".to_owned(),
            Self::Provider => "provider".to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_measured_budget_keeps_a_margin_under_the_limit() {
        let budget = Budget::measured(60_000, Some(100_000));

        assert_eq!(budget.compute_unit_limit, 66_000);
        assert_eq!(budget.loaded_accounts_data_size_limit, 110_000);
        assert_eq!(Budget::measured(1_390_000, None).compute_unit_limit, MAX_COMPUTE_UNITS);
    }
}
