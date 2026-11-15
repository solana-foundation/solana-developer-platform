use core::ops::Range;

use sdp_intents_engine::{Chain, Payers, Recipe};
use sdp_intents_spec::builder::Ready;
use sdp_intents_spec::{Address, Implementation, IntentOptions, RecipeKind, ValueRef, ValueSource};

use crate::flow_step::FlowPart;
use crate::render::{base58, Column};
use crate::time::utc_time;
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

/// Who built the instructions, when the registry did not, and what the chain checks, in words a
/// signer reads without knowing the system: `checked onchain: instructions and guarantees` when
/// `verify_intent` rebuilds the instructions and the assertions hold the guarantees. When a
/// builder outside the registry builds them, `verify_intent` limits them to their programs.
fn checks_text(implementation: Implementation<'_>, options: IntentOptions) -> Result<String, PlanError> {
    let url = || printable(implementation.url()?);
    let (built_by, rebuilt) = match implementation.recipe()? {
        RecipeKind::Static | RecipeKind::Program => (String::new(), true),
        RecipeKind::Remote => (format!("built by {}, ", url()?), false),
        RecipeKind::RemoteTransaction => (format!("built and signed by {}, ", url()?), false),
        RecipeKind::Shielded => ("a private spend, ".to_owned(), false),
        RecipeKind::Flow => return Err(PlanError::FlowRecipe),
    };
    let instructions = if rebuilt { "instructions" } else { "programs" };
    let checked = match (options.verify_intent, options.assertions) {
        (true, true) => format!("checked onchain: {instructions} and guarantees"),
        (true, false) => format!("checked onchain: {instructions}"),
        (false, true) => "checked onchain: guarantees".to_owned(),
        (false, false) => "not checked onchain, only simulated".to_owned(),
    };

    Ok(format!("{built_by}{checked}"))
}

/// The builder program of a program recipe.
pub(crate) fn builder_program(recipe: &Recipe<'_>) -> Option<Address> {
    let implementation = recipe.implementation();
    let call = implementation.instructions().ok()?.first()?;

    (implementation.recipe().ok()? == sdp_intents_spec::RecipeKind::Program)
        .then(|| recipe.address(call.program).copied())
        .flatten()
}

/// The parts of the plan message that no intent holds.
pub(crate) struct MessageHeader<'h> {
    pub(crate) cluster: Option<&'h Address>,
    pub(crate) expires_at: Option<u64>,
    pub(crate) payers: Payers<'h>,
    pub(crate) priority_fee_lamports: u64,
    /// The flow that the plan is a step of.
    pub(crate) flow: Option<&'h FlowPart>,
}

/// The plan message, outcome first: `<outcomes> || intents on <cluster> | expires <UTC time> |
/// paid by <payer> | priority fee <SOL> SOL || <details>`. A zero priority fee is left out. A flow's
/// step starts `step <i> of <n>: <outcome> || flow <id>: <the flow's outcome>`. With more than one intent, each
/// outcome and each detail starts with `<number>: `, and `||` separates them.
pub(crate) fn plan_message(header: &MessageHeader<'_>, parts: &[MessagePart]) -> String {
    let numbered = |texts: Vec<&str>| match texts.as_slice() {
        [one] => (*one).to_owned(),
        _ => (1usize..).zip(texts).map(|(number, text)| format!("{number}: {text}")).collect::<Vec<_>>().join(" || "),
    };
    let outcomes = numbered(parts.iter().map(|part| part.outcome.as_str()).collect());
    let outcomes = match header.flow {
        Some(flow) => format!(
            "step {} of {}: {outcomes} || flow {}: {}",
            u16::from(flow.step).saturating_add(1),
            flow.steps,
            flow.id,
            flow.outcome
        ),
        None => outcomes,
    };
    let details = numbered(parts.iter().map(|part| part.details.as_str()).collect());

    let cluster = header.cluster.map_or_else(String::new, |cluster| {
        format!(" on {}", sdp_intents_spec::cluster::name(cluster).map_or_else(|| base58(cluster), str::to_owned))
    });
    let expires = header.expires_at.map_or_else(String::new, |time| format!(" | expires {}", utc_time(time)));
    let payers = match header.payers.fee == header.payers.rent {
        true => format!("paid by {}", base58(header.payers.fee)),
        false => format!("fee paid by {} | rent paid by {}", base58(header.payers.fee), base58(header.payers.rent)),
    };
    let priority_fee = match header.priority_fee_lamports {
        0 => String::new(),
        lamports => format!(" | priority fee {} SOL", sol(lamports)),
    };

    format!("{outcomes} || intents{cluster}{expires} | {payers}{priority_fee} || {details}")
}

/// Lamports as SOL, such as `0.00148844`.
fn sol(lamports: u64) -> String {
    crate::render::with_decimals(lamports.to_string(), Some(9))
}

/// One intent's part of the plan message: what it does, then how it is built and checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MessagePart {
    pub(crate) outcome: String,
    pub(crate) details: String,
}

impl MessagePart {
    /// The most that the rent payer spends, in SOL. A segment that creates no account states none.
    pub(crate) fn with_rent_cap(self, rent_cap: u64) -> Self {
        match rent_cap {
            0 => self,
            _ => Self { details: format!("{} | rent up to {} SOL", self.details, sol(rent_cap)), ..self },
        }
    }
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

    /// The intent's part of the plan message. The outcome is the implementation's message. The
    /// details are `<implementation id> for <interface id> | <who built it, and what the chain
    /// checks>`. An id is the organization, the name, and the version, such as
    /// `solana.org/token.transfer@1.0.0`, and the interface leaves out an organization that it shares
    /// with the implementation. The segment adds the rent after its first simulation.
    pub(crate) fn message(&self) -> Result<MessagePart, PlanError> {
        let interface = self.recipe.interface();
        let implementation = self.recipe.implementation();
        let rendered = self.render(implementation.message()?, Column::Message)?;
        let version = |id: &sdp_intents_spec::wire::DocumentIdV1| {
            format!("{}.{}.{}", id.version.major.get(), id.version.minor.get(), id.version.patch.get())
        };
        let organization = self.organization(&implementation.id().publisher)?;
        let interface_organization = match interface.id().publisher == implementation.id().publisher {
            true => String::new(),
            false => format!("{}/", self.organization(&interface.id().publisher)?),
        };

        let checks = checks_text(*implementation, self.recipe.intent().options()?)?;
        let settlement = if interface.settles_later() { " | settles later" } else { "" };

        Ok(MessagePart {
            outcome: format!("{rendered}{settlement}"),
            details: format!(
                "{organization}/{}@{} for {interface_organization}{}@{} | {checks}",
                printable(implementation.name()?)?,
                version(implementation.id()),
                printable(interface.name()?)?,
                version(interface.id()),
            ),
        })
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
pub(crate) fn printable(bytes: &[u8]) -> Result<&str, PlanError> {
    let text = core::str::from_utf8(bytes).map_err(|_| PlanError::UnsafeText)?;

    match text.bytes().all(|byte| (b' '..=b'~').contains(&byte)) {
        true => Ok(text),
        false => Err(PlanError::UnsafeText),
    }
}
