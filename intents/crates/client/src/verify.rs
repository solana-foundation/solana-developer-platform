//! Verifies a transaction for its signer: the planner's verifier, answered over RPC. A wallet calls
//! [`Client::verify_message`] with the message that it signs, of any version.

use sdp_intents_planner::{verify_transaction, AccountMap, Transaction, VerifiedTransaction, VerifyStep};

use crate::message::{LookupTable, WireMessage};
use crate::{Client, ClientError};

/// Each `verify_intent` needs its two version accounts, then the accounts that its recipe and its
/// message read. A plan of many intents asks for each kind in one call.
const MAX_FETCH_ROUNDS: usize = 8;

impl Client {
    /// The plan message that `message` proves, and the instructions that no segment holds.
    pub fn verify_message(&self, message: &[u8]) -> Result<VerifiedTransaction, ClientError> {
        self.verify(&self.decode(&WireMessage::parse(message)?)?)
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

    /// The transaction of `message`, with the addresses of its lookup tables read over RPC.
    pub fn decode(&self, message: &WireMessage) -> Result<Transaction, ClientError> {
        Ok(message.decode(&self.lookup_tables(&message.lookup_tables())?)?)
    }

    /// The lookup tables at `addresses`, in one call, or none for none.
    pub fn lookup_tables(&self, addresses: &[sdp_intents_spec::Address]) -> Result<Vec<LookupTable>, ClientError> {
        if addresses.is_empty() {
            return Ok(Vec::new());
        }

        let fetched = self.fetch(addresses)?;

        let tables =
            addresses.iter().zip(&fetched).map(|(address, account)| LookupTable::read(*address, account.as_ref()));

        Ok(tables.collect::<Result<_, _>>()?)
    }
}
