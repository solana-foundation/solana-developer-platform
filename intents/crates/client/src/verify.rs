//! Verifies a transaction for its signer: the planner's verifier, answered over RPC. A wallet calls
//! [`Client::verify_message`] with the v1 message that it signs.

use solana_message::v1;

use sdp_intents_planner::{
    verify_transaction, AccountMap, AccountMeta, Budget, Instruction, Transaction, VerifiedTransaction, VerifyStep,
};
use sdp_intents_spec::{AccountRole, Address};

use crate::{Client, ClientError};

/// Each `verify_intent` needs its two version accounts, then the accounts that its recipe and its
/// message read. A plan of many intents asks for each kind in one call.
const MAX_FETCH_ROUNDS: usize = 8;

impl Client {
    /// The plan message that `message` proves, and the instructions that no segment holds.
    pub fn verify_message(&self, message: &[u8]) -> Result<VerifiedTransaction, ClientError> {
        self.verify(&transaction(message)?)
    }

    pub fn verify(&self, transaction: &Transaction) -> Result<VerifiedTransaction, ClientError> {
        let mut accounts = AccountMap::default();

        for _ in 0..MAX_FETCH_ROUNDS {
            match verify_transaction(transaction, &accounts)? {
                VerifyStep::Fetch(addresses) => accounts.insert_fetched(&addresses, self.fetch(&addresses)?),
                VerifyStep::Done(verified) => return Ok(*verified),
            }
        }

        Err(ClientError::Decode("the verifier asked for accounts in more than 8 rounds".to_owned()))
    }
}

/// The transaction of a serialized v1 message, which starts with its version byte. The header gives each account's role: the signers
/// come first, writable before readonly, then the other writable accounts, then the readonly ones.
pub(crate) fn transaction(message: &[u8]) -> Result<Transaction, ClientError> {
    let body = match message.split_first() {
        Some((&v1::V1_PREFIX, body)) => body,
        _ => return Err(ClientError::Decode("the message is not a v1 message".into())),
    };
    let message = v1::deserialize(body).map_err(|error| ClientError::Decode(error.to_string()))?;
    let keys: Vec<Address> = message.account_keys.iter().map(|key| Address(key.to_bytes())).collect();
    let header = message.header;
    let signers = usize::from(header.num_required_signatures);
    let writable_signers = signers.saturating_sub(usize::from(header.num_readonly_signed_accounts));
    let writable_end = keys.len().saturating_sub(usize::from(header.num_readonly_unsigned_accounts));
    let role = |index: usize| {
        let writable = index < writable_signers || (index >= signers && index < writable_end);

        AccountRole::new(writable, index < signers)
    };
    let key = |index: u8| {
        keys.get(usize::from(index)).copied().ok_or_else(|| ClientError::Decode("an index has no key".into()))
    };

    let instructions = message
        .instructions
        .iter()
        .map(|instruction| {
            let accounts = instruction
                .accounts
                .iter()
                .map(|index| Ok(AccountMeta { address: key(*index)?, role: role(usize::from(*index)) }))
                .collect::<Result<Vec<_>, ClientError>>()?;

            Ok(Instruction { program: key(instruction.program_id_index)?, accounts, data: instruction.data.clone() })
        })
        .collect::<Result<Vec<_>, ClientError>>()?;

    let config = message.config;
    let budget = Budget {
        compute_unit_limit: config.compute_unit_limit.unwrap_or_default(),
        loaded_accounts_data_size_limit: config.loaded_accounts_data_size_limit.unwrap_or_default(),
        heap_size: config.heap_size.unwrap_or_default(),
    };

    Ok(Transaction {
        fee_payer: *keys.first().ok_or_else(|| ClientError::Decode("the message has no fee payer".into()))?,
        instructions,
        budget,
        priority_fee_lamports: config.priority_fee.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use solana_hash::Hash;

    use super::*;
    use crate::rpc;

    /// A message decodes to the transaction that compiled it, with each role from the header.
    #[test]
    fn decodes_a_compiled_message() {
        let fee_payer = Address([1; 32]);
        let account = |byte: u8, role: AccountRole| AccountMeta { address: Address([byte; 32]), role };
        let original = Transaction {
            fee_payer,
            instructions: vec![Instruction {
                program: Address([9; 32]),
                accounts: vec![
                    account(1, AccountRole::WritableSigner),
                    account(2, AccountRole::ReadonlySigner),
                    account(3, AccountRole::Writable),
                    account(4, AccountRole::Readonly),
                ],
                data: vec![7, 8],
            }],
            budget: Budget { compute_unit_limit: 20_000, loaded_accounts_data_size_limit: 9_000, heap_size: 32 * 1024 },
            priority_fee_lamports: 5_000,
        };
        let message = rpc::message(&original, Hash::default()).unwrap().serialize();

        assert_eq!(transaction(&message).unwrap(), original);
    }
}
