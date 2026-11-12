//! Converts the planner's requests to RPC calls, and the RPC answers back.

use base64::Engine as _;
use solana_account_decoder_client_types::UiAccount;
use solana_hash::Hash;
use solana_message::v1::{self, TransactionConfig};
use solana_message::VersionedMessage;
use solana_rpc_client_api::response::RpcSimulateTransactionResult;
use solana_signature::Signature;
use solana_transaction::versioned::VersionedTransaction;

use sdp_intents_planner::{Account, Instruction, ReturnData, Simulation, SimulationResult, Transaction};
use sdp_intents_spec::Address;

use crate::ClientError;

pub(crate) fn solana_address(address: Address) -> solana_address::Address {
    solana_address::Address::new_from_array(address.0)
}

pub(crate) fn base58(address: Address) -> String {
    bs58::encode(address.0).into_string()
}

/// The v1 message of a transaction: what its signers sign.
pub(crate) fn message(transaction: &Transaction, blockhash: Hash) -> Result<v1::Message, ClientError> {
    let instructions: Vec<solana_instruction::Instruction> = transaction.instructions.iter().map(instruction).collect();
    let budget = transaction.budget;
    let config = TransactionConfig::empty()
        .with_priority_fee(transaction.priority_fee_lamports)
        .with_compute_unit_limit(budget.compute_unit_limit)
        .with_loaded_accounts_data_size_limit(budget.loaded_accounts_data_size_limit)
        .with_heap_size(budget.heap_size);

    v1::Message::try_compile_with_config(&solana_address(transaction.fee_payer), &instructions, blockhash, config)
        .map_err(|error| ClientError::Compile(format!("{error:?}")))
}

/// A simulation as a v1 transaction with empty signatures. A simulation with `sigVerify` off does
/// not read them, and one with `replaceRecentBlockhash` on replaces the default blockhash.
pub(crate) fn simulation_transaction(simulation: &Simulation) -> Result<VersionedTransaction, ClientError> {
    let message = message(&simulation.transaction, Hash::default())?;
    let signatures = vec![Signature::default(); usize::from(message.header.num_required_signatures)];

    Ok(VersionedTransaction { signatures, message: VersionedMessage::V1(message) })
}

fn instruction(instruction: &Instruction) -> solana_instruction::Instruction {
    let accounts = instruction
        .accounts
        .iter()
        .map(|meta| solana_instruction::AccountMeta {
            pubkey: solana_address(meta.address),
            is_signer: meta.role.signer(),
            is_writable: meta.role.writable(),
        })
        .collect();

    solana_instruction::Instruction {
        program_id: solana_address(instruction.program),
        accounts,
        data: instruction.data.clone(),
    }
}

pub(crate) fn simulation_result(result: RpcSimulateTransactionResult) -> Result<SimulationResult, ClientError> {
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

fn ui_account(account: &UiAccount) -> Result<Account, ClientError> {
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
    use sdp_intents_planner::{AccountMeta, Budget};
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
