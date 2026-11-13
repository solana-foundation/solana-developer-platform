//! The `verify_intent` instruction of the registry program, as the planner builds it into a segment.
//! `DESIGN.md`, section 4.6, gives its accounts and data.

use sha2::{Digest as _, Sha256};

use sdp_intents_engine::Recipe;
use sdp_intents_spec::wire::{DocumentIdV1, DocumentKind};
use sdp_intents_spec::{AccountRole, Address};

use crate::{AccountMeta, Instruction, Limit, PlanError};

/// `9sgttDZ2vnzb85HWuQbx8vy6Boga32zpP5QRZ7UtbWpp`.
pub const REGISTRY_PROGRAM: Address = Address([
    131, 217, 165, 14, 242, 154, 37, 232, 205, 185, 77, 119, 196, 52, 155, 177, 116, 173, 206, 209, 58, 232, 41, 103,
    187, 187, 37, 64, 150, 138, 246, 201,
]);
/// `Sysvar1nstructions1111111111111111111111111`.
const INSTRUCTIONS_SYSVAR: Address = Address([
    6, 167, 213, 23, 24, 123, 209, 102, 53, 218, 212, 4, 85, 253, 194, 192, 193, 36, 198, 143, 33, 86, 117, 165, 219,
    186, 203, 95, 8, 0, 0, 0,
]);

/// What `verify_intent` reads, besides the recipe.
pub(crate) struct VerifyIntent<'v> {
    /// The intent document, which is the instruction's data.
    pub(crate) intent: &'v [u8],
    /// The accounts of a builder's last round.
    pub(crate) extra_accounts: &'v [Address],
    /// The builder's role of each account of its instructions, in order. A static recipe has none.
    pub(crate) builder_roles: Vec<u8>,
    /// The interface's outputs, in borsh, which `verify_intent` checks against the record.
    pub(crate) outputs: &'v [u8],
    /// The most that the rent payer spends on new accounts in the segment.
    pub(crate) rent_cap: u64,
    /// The accounts that the span can change, which the assertions guard.
    pub(crate) guarded: &'v [Address],
    pub(crate) counts: SegmentCounts,
}

/// The instructions of a segment after `verify_intent`, which `verify_intent` checks, so a signer
/// can read the segment from the data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SegmentCounts {
    pub(crate) snapshots: u8,
    pub(crate) built: u8,
    pub(crate) checks: u8,
}

impl VerifyIntent<'_> {
    /// The accounts are the instructions sysvar, the fee payer, the rent payer, the two indexes, the
    /// two version accounts, the record's account table, the extra accounts, and the guarded
    /// accounts. Each one is readonly.
    pub(crate) fn instruction(&self, recipe: &Recipe<'_>) -> Result<Instruction, PlanError> {
        let interface = recipe.interface().id();
        let implementation = recipe.implementation().id();
        let payers = recipe.payers();
        let registry = [
            INSTRUCTIONS_SYSVAR,
            *payers.fee,
            *payers.rent,
            index_address(DocumentKind::Interface, interface)?,
            index_address(DocumentKind::Implementation, implementation)?,
            version_address(DocumentKind::Interface, interface)?,
            version_address(DocumentKind::Implementation, implementation)?,
        ];
        let table_len = recipe.implementation().accounts()?.len();
        let record = (0u8..)
            .take(table_len)
            .map(|account| recipe.address(account).copied().ok_or(PlanError::Unresolved))
            .collect::<Result<Vec<_>, _>>()?;

        let accounts = registry
            .into_iter()
            .chain(record)
            .chain(self.extra_accounts.iter().copied())
            .chain(self.guarded.iter().copied())
            .map(|address| AccountMeta { address, role: AccountRole::Readonly })
            .collect();

        Ok(Instruction { program: REGISTRY_PROGRAM, accounts, data: self.data()? })
    }

    /// The Anchor discriminator, then each argument in borsh: the intent, the builder roles, and the
    /// outputs as a `u32` length and the bytes, then the layout: the rent cap, the count of guarded
    /// accounts, and the counts of the segment.
    fn data(&self) -> Result<Vec<u8>, PlanError> {
        let length = |bytes: &[u8]| {
            u32::try_from(bytes.len()).map_err(|_| PlanError::DoesNotFit {
                limit: Limit::Bytes,
                used: bytes.len(),
                max: u32::MAX as usize,
            })
        };
        let discriminator = verify_intent_discriminator();
        let guarded = u8::try_from(self.guarded.len()).map_err(|_| PlanError::DoesNotFit {
            limit: Limit::Accounts,
            used: self.guarded.len(),
            max: usize::from(u8::MAX),
        })?;

        Ok([
            &discriminator[..],
            &length(self.intent)?.to_le_bytes(),
            self.intent,
            &length(&self.builder_roles)?.to_le_bytes(),
            &self.builder_roles,
            &length(self.outputs)?.to_le_bytes(),
            self.outputs,
            &self.rent_cap.to_le_bytes(),
            &[guarded, self.counts.snapshots, self.counts.built, self.counts.checks],
        ]
        .concat())
    }
}

/// The Anchor discriminator of `verify_intent`: the first 8 bytes of the SHA-256 of
/// `global:verify_intent`.
pub(crate) fn verify_intent_discriminator() -> [u8; 8] {
    let digest: [u8; 32] = Sha256::digest(b"global:verify_intent").into();
    let [discriminator, ..] = digest.as_chunks::<8>().0 else { return [0; 8] };

    *discriminator
}

fn index_address(kind: DocumentKind, id: &DocumentIdV1) -> Result<Address, PlanError> {
    find(&[b"index", &[kind.into()], &id.publisher.0, &id.name_hash])
}

pub(crate) fn version_address(kind: DocumentKind, id: &DocumentIdV1) -> Result<Address, PlanError> {
    let seed: &[u8] = if kind == DocumentKind::Interface { b"interface" } else { b"implementation" };
    let version = &id.version;

    find(&[seed, &id.publisher.0, &id.name_hash, &version.major.0, &version.minor.0, &version.patch.0])
}

fn find(seeds: &[&[u8]]) -> Result<Address, PlanError> {
    let program = solana_address::Address::new_from_array(REGISTRY_PROGRAM.0);
    let (address, _bump) =
        solana_address::Address::try_find_program_address(seeds, &program).ok_or(PlanError::NoRegistryAddress)?;

    Ok(Address(address.to_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_constants_are_the_registry_and_the_sysvar() {
        let base58 = |address: &Address| bs58::encode(address.0).into_string();

        assert_eq!(base58(&REGISTRY_PROGRAM), "9sgttDZ2vnzb85HWuQbx8vy6Boga32zpP5QRZ7UtbWpp");
        assert_eq!(base58(&INSTRUCTIONS_SYSVAR), "Sysvar1nstructions1111111111111111111111111");
    }
}
