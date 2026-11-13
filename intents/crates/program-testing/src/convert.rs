//! Converts the planner's types to LiteSVM's.

use solana_account::AccountSharedData;
use solana_account::ReadableAccount;
use solana_instruction::{AccountMeta, Instruction};

use sdp_intents_planner::{Account, Transaction};
use sdp_intents_spec::Address;

/// `ComputeBudget111111111111111111111111111111`.
const COMPUTE_BUDGET_PROGRAM: [u8; 32] = [
    3, 6, 70, 111, 229, 33, 23, 50, 255, 236, 173, 186, 114, 195, 155, 231, 188, 140, 229, 187, 197, 247, 18, 107, 44,
    67, 155, 58, 64, 0, 0, 0,
];
const REQUEST_HEAP_FRAME: u8 = 1;
const SET_COMPUTE_UNIT_LIMIT: u8 = 2;
const SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT: u8 = 4;
const DEFAULT_HEAP_SIZE: u32 = 32 * 1024;

pub(crate) fn solana_address(address: &Address) -> solana_address::Address {
    solana_address::Address::new_from_array(address.0)
}

/// The ComputeBudget instructions of the budget, then the transaction's instructions.
pub(crate) fn instructions(transaction: &Transaction) -> Vec<Instruction> {
    let budget = transaction.budget;
    let compute_budget = |kind: u8, value: u32| Instruction {
        program_id: solana_address::Address::new_from_array(COMPUTE_BUDGET_PROGRAM),
        accounts: Vec::new(),
        data: [&[kind][..], &value.to_le_bytes()].concat(),
    };

    let mut budget_instructions = vec![
        compute_budget(SET_COMPUTE_UNIT_LIMIT, budget.compute_unit_limit),
        compute_budget(SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT, budget.loaded_accounts_data_size_limit),
    ];

    if budget.heap_size > DEFAULT_HEAP_SIZE {
        budget_instructions.push(compute_budget(REQUEST_HEAP_FRAME, budget.heap_size));
    }

    let built = transaction.instructions.iter().map(|instruction| Instruction {
        program_id: solana_address(&instruction.program),
        accounts: instruction
            .accounts
            .iter()
            .map(|meta| AccountMeta {
                pubkey: solana_address(&meta.address),
                is_signer: meta.role.signer(),
                is_writable: meta.role.writable(),
            })
            .collect(),
        data: instruction.data.clone(),
    });

    budget_instructions.into_iter().chain(built).collect()
}

/// An account after a run. An account with no lamports does not exist.
pub(crate) fn post_account(account: &AccountSharedData) -> Option<Account> {
    (account.lamports() > 0).then(|| Account {
        owner: Address(account.owner().to_bytes()),
        lamports: account.lamports(),
        data: account.data().to_vec(),
    })
}
