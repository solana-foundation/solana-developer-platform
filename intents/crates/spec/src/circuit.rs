//! The circuit document (`DESIGN.md`, 4.17): what a shielded recipe's spender proves with. It pins
//! the proving keys and the prover module by hash, and lists where to fetch them. The bytes stay off
//! chain, because a wrong key only makes a proof that fails. Spec 1.1 adds it.

use bytemuck::{Pod, Zeroable};

use crate::code::wire_code;
use crate::region::Region;
use crate::{DocumentHeaderV1, DocumentIdV1, DocumentKind, PoolRefV1, ShieldedProtocol, SpecError, TableRefV1};

wire_code! {
    pub enum ProofSystem {
        Groth16Bn254 = 1,
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct CircuitDocV1 {
    pub header: DocumentHeaderV1,
    pub id: DocumentIdV1,
    pub name: PoolRefV1,
    pub protocol: u8,
    pub proof_system: u8,
    /// The SHA-256 of the proving key set: each key's name, a zero byte, and the key's SHA-256,
    /// sorted by name.
    pub proving_keys: [u8; 32],
    /// The SHA-256 of the WebAssembly prover, or zeros while the protocol has none.
    pub module: [u8; 32],
    /// URLs that serve the keys and the module, as pool ranges.
    pub sources: TableRefV1,
    pub pool: PoolRefV1,
}

/// A circuit document that `parse` validated, borrowed from its bytes.
#[derive(Clone, Copy)]
pub struct Circuit<'a> {
    body: &'a [u8],
    fixed: &'a CircuitDocV1,
}

impl<'a> Circuit<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, SpecError> {
        let header: &DocumentHeaderV1 = Region::new(bytes).fixed(0)?;
        header.check(DocumentKind::Circuit, bytes.len())?;

        if header.spec_minor < 1 || header.extension_len.get() != 0 {
            return Err(SpecError::UnsupportedVersion);
        }

        let body_end =
            DocumentHeaderV1::LEN.checked_add(usize::from(header.body_len.get())).ok_or(SpecError::LengthMismatch)?;
        let body = bytes.get(..body_end).ok_or(SpecError::Truncated)?;
        let circuit = Self { body, fixed: Region::new(body).fixed(0)? };

        circuit.name()?;
        circuit.protocol()?;
        circuit.proof_system()?;
        circuit.sources()?.iter().try_for_each(|source| circuit.text(*source).map(|_| ()))?;

        Ok(circuit)
    }

    pub fn id(&self) -> &'a DocumentIdV1 {
        &self.fixed.id
    }

    pub fn text(&self, range: PoolRefV1) -> Result<&'a [u8], SpecError> {
        Region::new(self.body).pool(self.fixed.pool)?.get(range)
    }

    pub fn name(&self) -> Result<&'a [u8], SpecError> {
        self.text(self.fixed.name)
    }

    pub fn protocol(&self) -> Result<ShieldedProtocol, SpecError> {
        ShieldedProtocol::try_from(self.fixed.protocol)
    }

    pub fn proof_system(&self) -> Result<ProofSystem, SpecError> {
        ProofSystem::try_from(self.fixed.proof_system)
    }

    pub fn proving_keys(&self) -> &'a [u8; 32] {
        &self.fixed.proving_keys
    }

    /// `None` while the protocol has no WebAssembly prover.
    pub fn module(&self) -> Option<&'a [u8; 32]> {
        (self.fixed.module != [0; 32]).then_some(&self.fixed.module)
    }

    pub fn sources(&self) -> Result<&'a [PoolRefV1], SpecError> {
        Region::new(self.body).table(self.fixed.sources)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_pinned() {
        assert_eq!(core::mem::size_of::<CircuitDocV1>(), 11 + 70 + 4 + 2 + 64 + 3 + 4);
    }
}
