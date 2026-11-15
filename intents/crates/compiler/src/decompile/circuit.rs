use sdp_intents_spec::Circuit;
use serde_json::Value;

use super::json::hex;
use super::json::{sparse_object, utf8};
use super::{document_name, DecompileError, Organizations};
use crate::circuit::{PROOF_SYSTEMS, PROTOCOLS};
use crate::envelope::SPEC_1_1;
use crate::id::format_version;

pub fn decompile_circuit(bytes: &[u8], organizations: &Organizations) -> Result<Value, DecompileError> {
    let circuit = Circuit::parse(bytes)?;
    let protocol = circuit.protocol()?;
    let proof_system = circuit.proof_system()?;
    let sources: Vec<Value> = circuit
        .sources()?
        .iter()
        .map(|source| utf8(circuit.text(*source)?).map(Value::from))
        .collect::<Result<_, _>>()?;

    Ok(sparse_object([
        ("spec", Some(Value::from(SPEC_1_1))),
        ("kind", Some(Value::from("circuit"))),
        ("id", Some(Value::from(document_name(circuit.id(), circuit.name()?, organizations)?))),
        ("version", Some(Value::from(format_version(circuit.id().version)))),
        ("protocol", PROTOCOLS.iter().find(|(_, known)| *known == protocol).map(|(name, _)| Value::from(*name))),
        (
            "proofSystem",
            PROOF_SYSTEMS.iter().find(|(_, known)| *known == proof_system).map(|(name, _)| Value::from(*name)),
        ),
        ("provingKeys", Some(Value::from(hex(circuit.proving_keys())))),
        ("module", circuit.module().map(|module| Value::from(hex(module)))),
        ("sources", Some(Value::Array(sources))),
    ]))
}
