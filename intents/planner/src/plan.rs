use core::ops::Range;

use sdp_intents_engine::{Chain, Payers, Recipe};
use sdp_intents_spec::builder::Ready;
use sdp_intents_spec::{Address, ValueRef, ValueSource};

use crate::render::{base58, Column};
use crate::values::{Table, Values};
use crate::{Instruction, PlanError, RequiredSignature, SignerRole, Transaction};

/// The plan of one or more intents: what the signers read, and the transaction they sign.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// What a signer reads and signs once for the whole transaction: the payers, the priority fee,
    /// then each intent's record message, guarantees, documents, and onchain checks.
    pub message: String,
    /// Each intent, in the order of its segment in the transaction.
    pub intents: Vec<PlannedIntent>,
    pub transaction: Transaction,
    pub signatures: Vec<RequiredSignature>,
    pub units_consumed: u64,
}

/// One intent of a plan, and where its segment is in the transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedIntent {
    /// The interface's display, for people.
    pub display: String,
    /// The SHA-256 of the interface and the implementation documents.
    pub digests: Digests,
    pub builder: Option<Address>,
    /// The interface's outputs, in order, in borsh.
    pub outputs: Vec<u8>,
    pub builder_simulations: usize,
    /// The position of the intent's `verify_intent`, when the intent keeps it.
    pub verify: Option<usize>,
    /// The positions of the instructions that the recipe built.
    pub span: Range<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Digests {
    pub interface: [u8; 32],
    pub implementation: [u8; 32],
}

/// `sdp-intents/1: fee payer <address> | rent payer <address> | priority fee <lamports> lamports`,
/// then `|| <n>: <part>` for each intent's part, in order. A signer renders the same text from the
/// transaction, so the plan needs one off-chain signature.
pub(crate) fn plan_message(payers: Payers<'_>, priority_fee_lamports: u64, parts: &[String]) -> String {
    let intents: String = (1usize..).zip(parts).map(|(number, part)| format!(" || {number}: {part}")).collect();

    format!(
        "sdp-intents/1: fee payer {} | rent payer {} | priority fee {priority_fee_lamports} lamports{intents}",
        base58(payers.fee),
        base58(payers.rent),
    )
}

/// What the recipe built: the instructions, the new accounts a builder signs for, and the outputs.
pub(crate) struct Built {
    pub(crate) instructions: Vec<Instruction>,
    pub(crate) signers: Vec<Address>,
    pub(crate) outputs: Vec<u8>,
}

impl Built {
    /// A static recipe binds each output to an account, and an address in borsh is its 32 bytes.
    pub(crate) fn from_static<C: Chain>(recipe: &Recipe<'_>, chain: &C) -> Result<Self, PlanError> {
        let instructions = recipe
            .instructions(chain)?
            .map(|built| built.and_then(|built| Instruction::built(&built)))
            .collect::<Result<Vec<_>, _>>()?;
        let outputs = (0u8..)
            .take(recipe.interface().outputs()?.len())
            .map(|output| recipe.output_address(output).map(|address| address.0))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self { instructions, signers: Vec::new(), outputs: outputs.concat() })
    }

    pub(crate) fn from_ready(recipe: &Recipe<'_>, ready: &Ready<'_>) -> Result<Self, PlanError> {
        let payers = recipe.payers();
        let instructions = ready
            .instructions()?
            .map(|instruction| instruction.and_then(|instruction| Instruction::ready(&instruction, payers)))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self { instructions, signers: ready.signers()?.to_vec(), outputs: ready.outputs()?.to_vec() })
    }

    /// The role of each account of the instructions, in order, as a builder writes them.
    pub(crate) fn roles(&self) -> Vec<u8> {
        self.instructions
            .iter()
            .flat_map(|instruction| instruction.accounts.iter().map(|meta| u8::from(meta.role)))
            .collect()
    }
}

impl<C: Chain> Values<'_, '_, C> {
    /// The message of each postcondition, the interface's first, in the order that verification
    /// checks them.
    pub(crate) fn guarantees(&self) -> Result<Vec<String>, PlanError> {
        let interface = self.recipe.interface();
        let implementation = self.recipe.implementation();
        let interface_messages = interface.post_conditions()?.iter().map(|condition| interface.text(condition.message));
        let implementation_messages =
            implementation.post_conditions()?.iter().map(|condition| implementation.text(condition.message));

        interface_messages
            .chain(implementation_messages)
            .map(|template| self.render(template?, Column::Message))
            .collect()
    }

    /// The intent's part of the plan message: `<record message> | guarantees: <each>; <each> |
    /// interface: <id> | implementation: <id>`, the builder for a program recipe, then the onchain
    /// checks. An id is the name, the version, and the first 8 bytes of the digest.
    pub(crate) fn message(
        &self,
        guarantees: &[String],
        digests: &Digests,
        builder: Option<&Address>,
    ) -> Result<String, PlanError> {
        let interface = self.recipe.interface();
        let implementation = self.recipe.implementation();
        let record = self.render(implementation.message()?, Column::Message)?;
        let id = |name: &[u8], version: sdp_intents_spec::wire::SemverV1, digest: &[u8; 32]| {
            let digest: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
            let version = format!("{}.{}.{}", version.major.get(), version.minor.get(), version.patch.get());

            format!("{}@{version} {digest}", String::from_utf8_lossy(name))
        };

        let builder = builder.map(|builder| format!(" | builder: {}", base58(builder))).unwrap_or_default();
        let checks = if self.recipe.intent().options()?.verify_intent { "verify_intent" } else { "none" };

        Ok(format!(
            "{record} | guarantees: {} | interface: {} | implementation: {}{builder} | onchain checks: {checks}",
            guarantees.join("; "),
            id(interface.name()?, interface.id().version, &digests.interface),
            id(implementation.name()?, implementation.id().version, &digests.implementation),
        ))
    }

    /// Why each signer signs. A signer that is no payer, no signer input, and no builder account
    /// has no reason to sign, so the plan refuses it.
    pub(crate) fn signatures(
        &self,
        transaction: &Transaction,
        built: &Built,
    ) -> Result<Vec<RequiredSignature>, PlanError> {
        let payers = self.recipe.payers();
        let inputs = self.recipe.interface().inputs()?;

        transaction
            .signers()
            .into_iter()
            .map(|address| {
                let input = (0u8..).zip(inputs).find(|(index, input)| {
                    input.signer()
                        && self.address(ValueRef { source: ValueSource::Input, index: *index }, Table::Interface).ok()
                            == Some(address)
                });

                let role = match input {
                    _ if address == *payers.fee => SignerRole::FeePayer,
                    _ if address == *payers.rent => SignerRole::RentPayer,
                    Some((_, input)) => SignerRole::Input(
                        String::from_utf8_lossy(self.recipe.interface().text(input.name)?).into_owned(),
                    ),
                    None if built.signers.contains(&address) => SignerRole::Builder,
                    None => return Err(PlanError::UnknownSigner(address)),
                };

                Ok(RequiredSignature { address, role })
            })
            .collect()
    }
}
