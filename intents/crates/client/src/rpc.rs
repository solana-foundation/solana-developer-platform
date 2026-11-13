//! Converts the planner's requests to RPC calls, and the RPC answers back.

use base64::Engine as _;
use solana_account_decoder_client_types::{UiAccount, UiAccountEncoding};
use solana_commitment_config::CommitmentConfig;
use solana_hash::Hash;
use solana_message::VersionedMessage;
use solana_rpc_client_api::config::{RpcSimulateTransactionAccountsConfig, RpcSimulateTransactionConfig};
use solana_rpc_client_api::response::RpcSimulateTransactionResult;
use solana_signature::Signature;
use solana_transaction::versioned::VersionedTransaction;

use sdp_intents_planner::{Account, ReturnData, Simulation, SimulationResult};
use sdp_intents_spec::Address;

use crate::ClientError;

pub use sdp_intents_message::{solana_address, v1_message};

pub fn base58(address: Address) -> String {
    bs58::encode(address.0).into_string()
}

/// A simulation as a v1 transaction with empty signatures, or as its fixed message of any version. A
/// simulation with `sigVerify` off does not read them, and one with `replaceRecentBlockhash` on
/// replaces the blockhash.
pub fn simulation_transaction(simulation: &Simulation) -> Result<VersionedTransaction, ClientError> {
    let message = match &simulation.fixed {
        Some(fixed) => crate::WireMessage::parse(&fixed.bytes)?.solana().clone(),
        None => VersionedMessage::V1(v1_message(&simulation.transaction, Hash::default())?),
    };
    let signatures = vec![Signature::default(); usize::from(message.header().num_required_signatures)];

    Ok(VersionedTransaction { signatures, message })
}

/// Simulates at `processed`, and returns each account of `observe` in base64.
pub fn simulation_config(simulation: &Simulation) -> RpcSimulateTransactionConfig {
    RpcSimulateTransactionConfig {
        sig_verify: false,
        replace_recent_blockhash: true,
        commitment: Some(CommitmentConfig::processed()),
        accounts: Some(RpcSimulateTransactionAccountsConfig {
            encoding: Some(UiAccountEncoding::Base64),
            addresses: simulation.observe.iter().copied().map(base58).collect(),
        }),
        ..RpcSimulateTransactionConfig::default()
    }
}

pub fn simulation_result(result: RpcSimulateTransactionResult) -> Result<SimulationResult, ClientError> {
    let return_data = result
        .return_data
        .map(|return_data| {
            let data = base64::engine::general_purpose::STANDARD.decode(&return_data.data.0)?;

            Ok::<_, ClientError>(ReturnData { program: parse_address(&return_data.program_id)?, data })
        })
        .transpose()?;
    let accounts = result
        .accounts
        .unwrap_or_default()
        .into_iter()
        .map(|account| account.map(|account| ui_account(&account)).transpose())
        .collect::<Result<Vec<_>, _>>()?;

    Ok(SimulationResult {
        error: result.err.map(|error| format!("{error:?}")),
        logs: result.logs.unwrap_or_default(),
        return_data,
        accounts,
        units_consumed: result.units_consumed,
        loaded_accounts_data_size: result.loaded_accounts_data_size,
        fee: result.fee,
    })
}

pub fn ui_account(account: &UiAccount) -> Result<Account, ClientError> {
    let data = account.data.decode().ok_or_else(|| ClientError::Decode("account data is not binary".to_owned()))?;

    Ok(Account { owner: parse_address(&account.owner)?, lamports: account.lamports, data })
}

fn parse_address(text: &str) -> Result<Address, ClientError> {
    let bytes = bs58::decode(text).into_vec().map_err(|error| ClientError::Decode(error.to_string()))?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| ClientError::Decode(format!("`{text}` is not an address")))?;

    Ok(Address(bytes))
}

#[cfg(test)]
mod tests {
    use sdp_intents_planner::{AccountMeta, Budget, Instruction, Transaction};
    use sdp_intents_spec::AccountRole;

    use super::*;

    #[test]
    fn a_simulation_is_a_v1_transaction_with_its_budget() {
        let funder = Address([1; 32]);
        let scratch = Address([2; 32]);
        let simulation = Simulation {
            transaction: Transaction {
                fee_payer: funder,
                instructions: vec![Instruction {
                    program: Address::default(),
                    accounts: vec![
                        AccountMeta { address: funder, role: AccountRole::WritableSigner },
                        AccountMeta { address: scratch, role: AccountRole::WritableSigner },
                    ],
                    data: vec![0; 52],
                }],
                budget: Budget::MAXIMUM,
                priority_fee_lamports: 5_000,
            },
            observe: vec![scratch],
            fixed: None,
        };

        let transaction = simulation_transaction(&simulation).unwrap();
        let VersionedMessage::V1(message) = &transaction.message else { panic!("the message is not v1") };

        assert_eq!(transaction.signatures.len(), 2);
        assert_eq!(message.account_keys.first(), Some(&solana_address(funder)));
        assert_eq!(message.config.compute_unit_limit, Some(1_400_000));
        assert_eq!(message.config.heap_size, Some(256 * 1024));
        assert_eq!(message.config.priority_fee, Some(5_000));
    }

    #[test]
    fn reads_the_return_data_and_the_scratch_account() {
        let builder = base58(Address([4; 32]));
        let result: RpcSimulateTransactionResult = serde_json::from_value(serde_json::json!({
            "err": null,
            "logs": ["Program log: ready"],
            "accounts": [{ "lamports": 1, "data": ["AQID", "base64"], "owner": builder, "executable": false, "rentEpoch": 0 }],
            "unitsConsumed": 4200,
            "returnData": { "programId": builder, "data": ["CQ==", "base64"] }
        }))
        .unwrap();

        let result = simulation_result(result).unwrap();

        assert_eq!(result.return_data, Some(ReturnData { program: Address([4; 32]), data: vec![9] }));
        assert_eq!(result.accounts, [Some(Account { owner: Address([4; 32]), lamports: 1, data: vec![1, 2, 3] })]);
        assert_eq!(result.units_consumed, Some(4200));
    }
}
