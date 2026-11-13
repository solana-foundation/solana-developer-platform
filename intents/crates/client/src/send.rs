//! Signs and sends transactions. A signer signs the serialized v1 message, with its version byte.

use solana_commitment_config::CommitmentConfig;
use solana_keypair::Keypair;
use solana_message::{v1, VersionedMessage};
use solana_signature::Signature;
use solana_signer::Signer as _;
use solana_transaction::versioned::VersionedTransaction;

use sdp_intents_planner::{ProviderSignature, Transaction};

use crate::{rpc, Client, ClientError};

impl Client {
    /// Compiles `transaction` with a recent blockhash, signs it, and sends it.
    pub fn send(&self, transaction: &Transaction, signers: &[&Keypair]) -> Result<Signature, ClientError> {
        let (blockhash, _) = self.rpc.get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())?;
        let message = rpc::message(transaction, blockhash)?;

        self.send_v1(message, signers)
    }

    /// Signs a serialized v1 message, such as the one that `prepare` returns, and sends it. Each
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

    fn send_v1(&self, message: v1::Message, signers: &[&Keypair]) -> Result<Signature, ClientError> {
        Ok(self.rpc.send_and_confirm_transaction(&sign_v1(message, signers, &[])?)?)
    }
}

/// The transaction of a serialized v1 message, signed by each signer that it requires. A provider's
/// signature in `presigned` stands for a signer that no keypair of `signers` holds.
pub fn sign_message(
    message: &[u8],
    signers: &[&Keypair],
    presigned: &[ProviderSignature],
) -> Result<VersionedTransaction, ClientError> {
    let body = message.strip_prefix(&[v1::V1_PREFIX]).ok_or_else(|| ClientError::Decode("not a v1 message".into()))?;
    let message = v1::deserialize(body).map_err(|error| ClientError::Decode(error.to_string()))?;

    sign_v1(message, signers, presigned)
}

fn sign_v1(
    message: v1::Message,
    signers: &[&Keypair],
    presigned: &[ProviderSignature],
) -> Result<VersionedTransaction, ClientError> {
    let required = usize::from(message.header.num_required_signatures);
    let message = VersionedMessage::V1(message);
    let bytes = message.serialize();
    let signatures = message
        .static_account_keys()
        .iter()
        .take(required)
        .map(|key| {
            let signer = signers.iter().find(|signer| signer.pubkey() == *key);
            let provider = presigned.iter().find(|signed| signed.signer.0 == key.to_bytes());

            signer
                .map(|signer| signer.sign_message(&bytes))
                .or_else(|| provider.map(|signed| Signature::from(signed.signature)))
                .ok_or(ClientError::MissingSigner(key.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(VersionedTransaction { signatures, message })
}
