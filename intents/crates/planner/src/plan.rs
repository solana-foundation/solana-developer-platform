use core::ops::Range;

use sdp_intents_engine::{Chain, Payers, Recipe};
use sdp_intents_spec::builder::Ready;
use sdp_intents_spec::{Address, RecipeKind, ValueRef, ValueSource};

use crate::render::{base58, Column};
use crate::values::{Table, Values};
use crate::{FrozenTransaction, Instruction, PlanError, RequiredSignature, SignerRole, Transaction};

/// The plan of one or more intents: what the signers read, and the transaction they sign.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// What a signer reads and signs once for the whole transaction: each intent's implementation message,
    /// documents, and onchain checks, then the payers and the priority fee.
    pub message: String,
    /// Each intent, in the order of its segment in the transaction.
    pub intents: Vec<PlannedIntent>,
    pub transaction: Transaction,
    pub signatures: Vec<RequiredSignature>,
    pub units_consumed: u64,
    /// The compute units of each instruction in the last simulation, which ran the whole
    /// transaction. A builtin program logs no units, so its entry is `None`.
    pub units_by_instruction: Vec<Option<u64>>,
    /// The provider's transaction, when the plan is one. A signer signs its message as it is.
    pub frozen: Option<FrozenTransaction>,
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

/// An intent's part of the plan message, which ends with the rent cap of its segment.
pub(crate) fn with_rent_cap(part: &str, rent_cap: u64) -> String {
    format!("{part} | rent cap {rent_cap} lamports")
}

/// The builder program of a program recipe.
pub(crate) fn builder_program(recipe: &Recipe<'_>) -> Option<Address> {
    let implementation = recipe.implementation();
    let call = implementation.instructions().ok()?.first()?;

    (implementation.recipe().ok()? == sdp_intents_spec::RecipeKind::Program)
        .then(|| recipe.address(call.program).copied())
        .flatten()
}

/// `sdp-intents/1 on <cluster>`, then `|| <n>: <part>` for each intent's part, in order, then `||
/// fee payer <address> | rent payer <address> | priority fee <lamports> lamports`. The cluster is
/// its name, such as `mainnet`, or its genesis hash when it has none. A transaction that proves
/// no intent names no cluster. One payer of both is `fee and rent payer <address>`. A signer
/// renders the same text from the transaction.
pub(crate) fn plan_message(
    cluster: Option<&Address>,
    payers: Payers<'_>,
    priority_fee_lamports: u64,
    parts: &[String],
) -> String {
    let cluster = cluster.map_or_else(String::new, |cluster| {
        format!(" on {}", sdp_intents_spec::cluster::name(cluster).map_or_else(|| base58(cluster), str::to_owned))
    });
    let intents: String = (1usize..).zip(parts).map(|(number, part)| format!(" || {number}: {part}")).collect();
    let payers = match payers.fee == payers.rent {
        true => format!("fee and rent payer {}", base58(payers.fee)),
        false => format!("fee payer {} | rent payer {}", base58(payers.fee), base58(payers.rent)),
    };

    format!("sdp-intents/1{cluster}{intents} || {payers} | priority fee {priority_fee_lamports} lamports")
}

/// What the recipe built: the instructions, the new accounts a builder signs for, and the outputs.
pub(crate) struct Built {
    pub(crate) instructions: Vec<Instruction>,
    pub(crate) signers: Vec<Address>,
    pub(crate) outputs: Vec<u8>,
    /// The canonical bumps of a builder's program addresses, which `verify_intent` passes back.
    pub(crate) builder_bumps: Vec<u8>,
    /// The provider's transaction of a remote recipe that returns one.
    pub(crate) frozen: Option<FrozenTransaction>,
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

        Ok(Self {
            instructions,
            signers: Vec::new(),
            outputs: outputs.concat(),
            builder_bumps: Vec::new(),
            frozen: None,
        })
    }

    /// `verify_intent` maps each account at the rent payer's address back to the placeholder, so a
    /// builder that names that address itself fails the check onchain. The planner refuses it first.
    pub(crate) fn from_ready(recipe: &Recipe<'_>, ready: &Ready<'_>) -> Result<Self, PlanError> {
        let payers = recipe.payers();
        let names_rent_payer = ready
            .instructions()?
            .map(|instruction| {
                instruction.map(|instruction| instruction.accounts.iter().any(|meta| meta.address == *payers.rent))
            })
            .collect::<Result<Vec<_>, _>>()?
            .contains(&true);

        if names_rent_payer && recipe.intent().options()?.verify_intent {
            return Err(PlanError::RentPayerInRecipe);
        }

        let instructions = ready
            .instructions()?
            .map(|instruction| instruction.and_then(|instruction| Instruction::ready(&instruction, payers)))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self {
            instructions,
            signers: ready.signers()?.to_vec(),
            outputs: ready.outputs()?.to_vec(),
            builder_bumps: ready.bumps()?.to_vec(),
            frozen: None,
        })
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

    /// The intent's part of the plan message: `<implementation message> | interface: <id> | implementation:
    /// <id> | <tier> | onchain checks: <checks>`. An id is the organization, the name, and the
    /// version, such as `solana.org/token.transfer@1.0.0`. The registry never publishes a version
    /// twice, so an id names one document. The segment adds the rent cap after its first simulation.
    pub(crate) fn message(&self) -> Result<String, PlanError> {
        let interface = self.recipe.interface();
        let implementation = self.recipe.implementation();
        let rendered = self.render(implementation.message()?, Column::Message)?;
        let id = |id: &sdp_intents_spec::wire::DocumentIdV1, name: &[u8]| {
            let version = format!("{}.{}.{}", id.version.major.get(), id.version.minor.get(), id.version.patch.get());

            Ok::<_, PlanError>(format!("{}/{}@{version}", self.organization(&id.publisher)?, printable(name)?))
        };

        let tier = match implementation.recipe()? {
            RecipeKind::Static | RecipeKind::Program => " | tier 1".to_owned(),
            RecipeKind::Remote => format!(" | endpoint: {} | tier 2", printable(implementation.url()?)?),
            RecipeKind::RemoteTransaction => {
                format!(" | endpoint: {} | tier 3, checked by simulation only", printable(implementation.url()?)?)
            }
            RecipeKind::Shielded => " | shielded | tier 3, checked by simulation only".to_owned(),
            RecipeKind::Flow => return Err(PlanError::FlowRecipe),
        };
        let options = self.recipe.intent().options()?;
        let checks = match (options.verify_intent, options.assertions) {
            (true, true) => "verify_intent, assertions",
            (true, false) => "verify_intent",
            (false, true) => "assertions",
            (false, false) => "none",
        };

        let settlement = if interface.settles_later() { " | settles later, outside this transaction" } else { "" };

        Ok(format!(
            "{rendered}{settlement} | interface: {} | implementation: {}{tier} | onchain checks: {checks}",
            id(interface.id(), interface.name()?)?,
            id(implementation.id(), implementation.name()?)?,
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
                    None if built.signers.contains(&address) && built.frozen.is_some() => SignerRole::Provider,
                    None if built.signers.contains(&address) => SignerRole::Builder,
                    None => return Err(PlanError::UnknownSigner(address)),
                };

                Ok(RequiredSignature { address, role })
            })
            .collect()
    }
}

/// Text that the message can hold: printable ASCII only, so that no character looks like another.
fn printable(bytes: &[u8]) -> Result<&str, PlanError> {
    let text = core::str::from_utf8(bytes).map_err(|_| PlanError::UnsafeText)?;

    match text.bytes().all(|byte| (b' '..=b'~').contains(&byte)) {
        true => Ok(text),
        false => Err(PlanError::UnsafeText),
    }
}
