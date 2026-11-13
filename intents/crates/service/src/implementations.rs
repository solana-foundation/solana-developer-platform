//! `implementationsFor`: the implementations of an interface, each with whether its `applies` checks
//! hold for the inputs. It reads the interface index, then the implementation indexes, then the
//! documents and the organizations in one call, then the accounts that each recipe resolves.

use std::cmp::Ordering;

use futures_util::future;
use serde_json::{json, Value};

use sdp_intents_chain::{CachedRpc, Freshness};
use sdp_intents_compiler::{format_version, IdRange};
use sdp_intents_engine::{EngineError, Payers, Recipe, Resolution};
use sdp_intents_planner::AccountMap;
use sdp_intents_registry_client::{IndexView, OrganizationView, INDEX_DISCRIMINATOR, REGISTRY_PROGRAM};
use sdp_intents_spec::wire::DocumentKind;
use sdp_intents_spec::{Address, Implementation, Interface, RecipeKind};

use crate::describe::{applies_text, base58, recipe_name, Names};
use crate::error::ServiceError;
use crate::registry::{catalog, first_finding, pick, released, Document, IndexKey, Registry, VersionChoice};

/// A record has at most 4 `hasOne` levels, and the hints can need one more read.
const MAX_RESOLVE_ROUNDS: usize = 6;

struct Request {
    interface_text: String,
    interface: IdRange,
    inputs: Value,
    fee_payer: Address,
    rent_payer: Address,
    all: bool,
}

/// An implementation index and the version of it to evaluate.
struct Candidate {
    address: Address,
    approved: bool,
    choice: VersionChoice,
}

/// Whether a record applies to the inputs. `DoesNotApply` is a failed `applies` check of the
/// record, and `InvalidInputs` is inputs that do not compile or that the recipe cannot read.
enum Fit {
    Applies,
    DoesNotApply(String),
    InvalidInputs(String),
    /// A read failed, or the documents do not load.
    Unknown(String),
}

struct Evaluated {
    id: String,
    version: String,
    recipe: RecipeKind,
    approved: bool,
    fit: Fit,
}

/// A body of `{ "interface", "inputs", "payers": { "fee", "rent" }, "all" }`. `all` adds the
/// implementations that the interface does not approve.
pub async fn implementations_for(chain: &CachedRpc, body: &Value) -> Result<Value, ServiceError> {
    let request = Request::parse(body)?;
    let interface = Registry { chain }
        .indexes(vec![IndexKey::interface(&request.interface.id)])
        .await?
        .pop()
        .ok_or_else(|| ServiceError::not_found("unknownInterface", "the registry holds no such interface"))?;
    let interface_view = interface.view()?;
    let interface_choice = VersionChoice::of(&interface_view, &pick(&interface_view, &request.interface)?)?;

    let candidates = candidates(chain, &interface.address, &interface_view, request.all).await?;
    let addresses = [interface_choice.address()?]
        .into_iter()
        .chain(candidates.iter().map(|candidate| candidate.choice.address()).collect::<Result<Vec<_>, _>>()?)
        .chain(candidates.iter().map(|candidate| candidate.choice.organization))
        .collect::<Vec<_>>();
    let mut accounts = chain.accounts(&addresses, Freshness::Published).await?.into_iter();

    let interface_document = Document {
        organization: request.interface.id.organization.clone(),
        kind: DocumentKind::Interface,
        bytes: interface_choice.document(accounts.next().flatten())?,
    };
    let documents: Vec<_> = accounts.by_ref().take(candidates.len()).collect();
    let organizations: Vec<_> = accounts.collect();

    let evaluations =
        candidates.iter().zip(documents).zip(organizations).map(|((candidate, document), organization)| {
            evaluate(chain, &request, &interface_document, candidate, document, organization)
        });
    let mut evaluated = future::join_all(evaluations).await.into_iter().collect::<Result<Vec<_>, _>>()?;
    evaluated.sort_by(rank);

    Ok(json!({
        "interface": { "id": request.interface.id.to_string(), "version": format_version(interface_choice.version) },
        "implementations": evaluated.iter().map(Evaluated::json).collect::<Vec<_>>(),
    }))
}

impl Request {
    fn parse(body: &Value) -> Result<Self, ServiceError> {
        let interface_text = body.get("interface").and_then(Value::as_str).ok_or_else(|| {
            ServiceError::invalid_request("`interface` is a range, such as `solana.org/token.transfer@^1`")
        })?;
        let interface = IdRange::parse(interface_text).map_err(ServiceError::invalid_request)?;
        let fee_payer = address(body.pointer("/payers/fee"))?.unwrap_or_default();
        let rent_payer = address(body.pointer("/payers/rent"))?.unwrap_or(fee_payer);

        Ok(Self {
            interface_text: interface_text.to_owned(),
            interface,
            inputs: body.get("inputs").cloned().unwrap_or_else(|| json!({})),
            fee_payer,
            rent_payer,
            all: body.get("all").and_then(Value::as_bool).unwrap_or(false),
        })
    }
}

/// The implementation indexes to evaluate, each at its highest released version. Without `all`,
/// only the versions that the interface approves.
async fn candidates(
    chain: &CachedRpc,
    interface: &Address,
    interface_view: &IndexView<'_>,
    all: bool,
) -> Result<Vec<Candidate>, ServiceError> {
    let indexes: Vec<(Address, Vec<u8>)> = if all {
        chain
            .program_accounts(&REGISTRY_PROGRAM, &INDEX_DISCRIMINATOR)
            .await?
            .into_iter()
            .map(|listed| (listed.address, listed.account.data))
            .collect()
    } else {
        let addresses = interface_view.approved().to_vec();
        let accounts = chain.accounts(&addresses, Freshness::Live).await?;
        addresses.iter().for_each(|address| chain.subscribe(*address));

        addresses
            .into_iter()
            .zip(accounts)
            .filter_map(|(address, account)| {
                account.filter(|account| account.owner == REGISTRY_PROGRAM).map(|account| (address, account.data))
            })
            .collect()
    };

    indexes
        .iter()
        .filter_map(|(address, data)| {
            let view = IndexView::parse(data).ok()?;
            let implements = view.kind() == Ok(DocumentKind::Implementation) && view.interface() == interface;
            let entry = released(&view).filter(|_| implements)?;
            let approved = interface_view.approves(address) && entry.approved;

            (all || approved)
                .then(|| Ok(Candidate { address: *address, approved, choice: VersionChoice::of(&view, &entry)? }))
        })
        .collect()
}

async fn evaluate(
    chain: &CachedRpc,
    request: &Request,
    interface: &Document,
    candidate: &Candidate,
    document: Option<sdp_intents_planner::Account>,
    organization: Option<sdp_intents_planner::Account>,
) -> Result<Evaluated, ServiceError> {
    let organization = organization
        .as_ref()
        .and_then(|account| OrganizationView::parse(&account.data).ok()?.name().ok().map(str::to_owned))
        .ok_or_else(|| {
            ServiceError::refused("wrongAccount", format!("{} has no organization", base58(&candidate.address)))
        })?;
    let implementation =
        Document { organization, kind: DocumentKind::Implementation, bytes: candidate.choice.document(document)? };
    let view = Implementation::parse(&implementation.bytes)
        .map_err(|error| ServiceError::refused("wrongDocument", error.to_string()))?;
    let id = format!("{}/{}", implementation.organization, String::from_utf8_lossy(view.name().unwrap_or_default()));
    let version = format_version(candidate.choice.version);
    let recipe = view.recipe().map_err(|error| ServiceError::refused("wrongDocument", error.to_string()))?;
    let fit = fit(chain, request, interface, &implementation, &format!("{id}@{version}")).await;

    Ok(Evaluated { id, version, recipe, approved: candidate.approved, fit })
}

/// Compiles the intent against the implementation, then resolves its accounts until every
/// `applies` check is decided.
async fn fit(
    chain: &CachedRpc,
    request: &Request,
    interface: &Document,
    implementation: &Document,
    reference: &str,
) -> Fit {
    let catalog = match catalog([interface, implementation]) {
        Ok(catalog) => catalog,
        Err(error) => return Fit::Unknown(error.message),
    };
    let intent = json!({
        "spec": "sdp-intents@1.0",
        "kind": "intent",
        "interface": request.interface_text,
        "implementation": reference,
        "inputs": request.inputs,
    })
    .to_string();
    let compiled = match catalog.compile_intent(&intent) {
        Ok(compiled) => compiled,
        Err(report) => return Fit::InvalidInputs(first_finding(&report)),
    };
    let payers = Payers { fee: &request.fee_payer, rent: &request.rent_payer };
    let mut recipe = match Recipe::parse(&interface.bytes, &implementation.bytes, &compiled.bytes, payers) {
        Ok(recipe) => recipe,
        Err(error) => return failed(interface, implementation, error),
    };
    let mut accounts = AccountMap::default();

    for _ in 0..MAX_RESOLVE_ROUNDS {
        let missing: Vec<Address> = match recipe.resolve(&accounts) {
            Ok(Resolution::Complete) => return Fit::Applies,
            Ok(Resolution::Missing(missing)) => missing.addresses().copied().collect(),
            Err(error) => return failed(interface, implementation, error),
        };

        match chain.accounts(&missing, Freshness::Live).await {
            Ok(fetched) => accounts.insert_fetched(&missing, fetched),
            Err(error) => return Fit::Unknown(error.to_string()),
        }
    }

    Fit::Unknown(format!("the recipe needs more than {MAX_RESOLVE_ROUNDS} reads"))
}

/// A failed `applies` check as its sentence. Any other error is inputs that the recipe cannot
/// read, with its message.
fn failed(interface: &Document, implementation: &Document, error: EngineError) -> Fit {
    let EngineError::AppliesFailed { applies } = error else {
        return Fit::InvalidInputs(error.to_string());
    };

    let sentence = Interface::parse(&interface.bytes)
        .ok()
        .zip(Implementation::parse(&implementation.bytes).ok())
        .and_then(|(interface, implementation)| {
            let names = Names::of_interface(&interface).ok()?.with_accounts(&implementation).ok()?;
            let check = implementation.applies().ok()?.get(usize::from(applies))?;

            applies_text(&implementation, check, &names).ok()
        });

    Fit::DoesNotApply(
        sentence.map_or_else(|| error.to_string(), |sentence| format!("the check \"{sentence}\" does not hold")),
    )
}

/// The implementations that apply first, then those not decided yet, then those with invalid
/// inputs, then those that do not apply. Within each, a static recipe, then a builder, then a
/// remote endpoint.
fn rank(left: &Evaluated, right: &Evaluated) -> Ordering {
    let fit = |evaluated: &Evaluated| match evaluated.fit {
        Fit::Applies => 0,
        Fit::Unknown(_) => 1,
        Fit::InvalidInputs(_) => 2,
        Fit::DoesNotApply(_) => 3,
    };
    let recipe = |evaluated: &Evaluated| match evaluated.recipe {
        RecipeKind::Static => 0,
        RecipeKind::Program => 1,
        RecipeKind::Remote => 2,
        RecipeKind::RemoteTransaction => 3,
    };

    fit(left).cmp(&fit(right)).then(recipe(left).cmp(&recipe(right))).then(left.id.cmp(&right.id))
}

impl Evaluated {
    fn json(&self) -> Value {
        let (status, reason) = match &self.fit {
            Fit::Applies => ("applies", None),
            Fit::DoesNotApply(reason) => ("doesNotApply", Some(reason)),
            Fit::InvalidInputs(reason) => ("invalidInputs", Some(reason)),
            Fit::Unknown(reason) => ("unknown", Some(reason)),
        };

        json!({
            "id": self.id,
            "version": self.version,
            "recipe": recipe_name(self.recipe),
            "approved": self.approved,
            "status": status,
            "reason": reason,
        })
    }
}

fn address(value: Option<&Value>) -> Result<Option<Address>, ServiceError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let bytes = value
        .as_str()
        .and_then(|text| bs58::decode(text).into_vec().ok())
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or_else(|| ServiceError::invalid_request("a payer is a base58 address"))?;

    Ok(Some(Address(bytes)))
}
