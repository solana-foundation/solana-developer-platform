//! Signs and sends transactions. A signer signs the serialized message, of any version.

use solana_commitment_config::CommitmentConfig;
use solana_keypair::Keypair;
use solana_signature::Signature;
use solana_signer::Signer as _;
use solana_transaction::versioned::VersionedTransaction;

use sdp_intents_planner::{ProviderSignature, Transaction};

use crate::message::{MessageVersion, WireMessage};
use crate::{Client, ClientError};

impl Client {
    /// Compiles `transaction` as v1 with a recent blockhash, signs it, and sends it.
    pub fn send(&self, transaction: &Transaction, signers: &[&Keypair]) -> Result<Signature, ClientError> {
        let message = WireMessage::compile(transaction, self.recent_blockhash()?, MessageVersion::V1, &[])?;

        Ok(self.rpc.send_and_confirm_transaction(&sign(&message, signers, &[])?)?)
    }

    /// Signs a serialized message, such as the one that `prepare` returns, and sends it. Each
    /// signer that the message requires must be in `signers` or in `presigned`.
    pub fn send_presigned(
        &self,
        message: &[u8],
        signers: &[&Keypair],
        presigned: &[ProviderSignature],
    ) -> Result<Signature, ClientError> {
        Ok(self.rpc.send_and_confirm_transaction(&sign_message(message, signers, presigned)?)?)
    }

    /// [`Client::send_presigned`] with no provider signatures.
    pub fn send_message(&self, message: &[u8], signers: &[&Keypair]) -> Result<Signature, ClientError> {
        Ok(self.rpc.send_and_confirm_transaction(&sign_message(message, signers, &[])?)?)
    }

    pub fn recent_blockhash(&self) -> Result<solana_hash::Hash, ClientError> {
        Ok(self.rpc.get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())?.0)
    }

    /// The message of `transaction` at a recent blockhash, of `version`, with the lookup tables at
    /// `tables` read over RPC.
    pub fn compile(
        &self,
        transaction: &Transaction,
        version: MessageVersion,
        tables: &[sdp_intents_spec::Address],
    ) -> Result<WireMessage, ClientError> {
        let tables = self.lookup_tables(tables)?;
        let message = WireMessage::compile(transaction, self.recent_blockhash()?, version, &tables)?;
        message.check_size()?;

        Ok(message)
    }
}

/// The transaction of a serialized message, signed by each signer that it requires. A provider's
/// signature in `presigned` stands for a signer that no keypair of `signers` holds.
pub fn sign_message(
    message: &[u8],
    signers: &[&Keypair],
    presigned: &[ProviderSignature],
) -> Result<VersionedTransaction, ClientError> {
    sign(&WireMessage::parse(message)?, signers, presigned)
}

pub fn sign(
    message: &WireMessage,
    signers: &[&Keypair],
    presigned: &[ProviderSignature],
) -> Result<VersionedTransaction, ClientError> {
    let signatures = message
        .signers()
        .iter()
        .map(|key| {
            let signer = signers.iter().find(|signer| signer.pubkey().to_bytes() == key.0);
            let provider = presigned.iter().find(|signed| signed.signer == *key);

            signer
                .map(|signer| signer.sign_message(message.bytes()))
                .or_else(|| provider.map(|signed| Signature::from(signed.signature)))
                .ok_or_else(|| ClientError::MissingSigner(crate::rpc::base58(*key)))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(VersionedTransaction { signatures, message: message.solana().clone() })
}
