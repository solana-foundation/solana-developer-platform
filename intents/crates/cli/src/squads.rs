//! The Squads v4 instructions that `apply --squads` uses: a vault transaction that holds the
//! registry instructions, a proposal for it, and, on a local multisig, the vote and the execution.
//! Squads is an Anchor program, so each instruction is the first 8 bytes of the SHA-256 of
//! `global:<instruction>`, then the arguments in borsh.
//!
//! A vault transaction holds its instructions in Squads' compact message: the counts of signers,
//! writable signers, and writable non-signers, then the account keys, then each instruction, each
//! list behind a one-byte length, and the instruction data behind a two-byte length.

use sha2::{Digest as _, Sha256};

use sdp_intents_planner::{AccountMeta, Instruction};
use sdp_intents_spec::{AccountRole, Address};

/// `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`.
pub const SQUADS_PROGRAM: Address = Address([
    6, 129, 196, 206, 71, 226, 35, 104, 184, 177, 85, 94, 200, 135, 175, 9, 46, 252, 126, 251, 182, 108, 163, 245, 47,
    191, 104, 212, 172, 156, 183, 168,
]);
const SYSTEM_PROGRAM: Address = Address([0; 32]);
/// A member who can initiate, vote, and execute.
const ALL_PERMISSIONS: u8 = 0b111;
/// The multisig account holds its last transaction index after the discriminator, the create key,
/// the config authority, the threshold, and the time lock.
const TRANSACTION_INDEX_OFFSET: usize = 8 + 32 + 32 + 2 + 4;
/// The program config holds its treasury after the discriminator, the authority, and the fee.
const TREASURY_OFFSET: usize = 8 + 32 + 8;

pub fn vault_address(multisig: &Address) -> Result<Address, String> {
    find(&[b"multisig", &multisig.0, b"vault", &[0]])
}

pub fn multisig_address(create_key: &Address) -> Result<Address, String> {
    find(&[b"multisig", b"multisig", &create_key.0])
}

pub fn program_config_address() -> Result<Address, String> {
    find(&[b"multisig", b"program_config"])
}

fn transaction_address(multisig: &Address, index: u64) -> Result<Address, String> {
    find(&[b"multisig", &multisig.0, b"transaction", &index.to_le_bytes()])
}

fn proposal_address(multisig: &Address, index: u64) -> Result<Address, String> {
    find(&[b"multisig", &multisig.0, b"transaction", &index.to_le_bytes(), b"proposal"])
}

/// The multisig's last transaction index. The next vault transaction takes the index after it.
pub fn transaction_index(multisig_data: &[u8]) -> Result<u64, String> {
    let bytes = multisig_data.get(TRANSACTION_INDEX_OFFSET..).and_then(|rest| rest.first_chunk::<8>());

    bytes.map(|bytes| u64::from_le_bytes(*bytes)).ok_or_else(|| "the account is not a Squads multisig".into())
}

pub fn treasury(program_config_data: &[u8]) -> Result<Address, String> {
    let bytes = program_config_data.get(TREASURY_OFFSET..).and_then(|rest| rest.first_chunk::<32>());

    bytes.map(|bytes| Address(*bytes)).ok_or_else(|| "the account is not the Squads program config".into())
}

/// A multisig whose only member is `member`, with a threshold of 1 and no time lock, for a local
/// run. `create_key` signs, and seeds the multisig's address.
pub fn create_multisig(member: &Address, create_key: &Address, treasury: &Address) -> Result<Instruction, String> {
    let args = [
        &[0][..],
        &1u16.to_le_bytes(),
        &1u32.to_le_bytes(),
        &member.0,
        &[ALL_PERMISSIONS],
        &0u32.to_le_bytes(),
        &[0],
        &[0],
    ]
    .concat();
    let accounts = vec![
        readonly(&program_config_address()?),
        writable(treasury),
        writable(&multisig_address(create_key)?),
        meta(create_key, AccountRole::ReadonlySigner),
        meta(member, AccountRole::WritableSigner),
        readonly(&SYSTEM_PROGRAM),
    ];

    Ok(instruction("multisig_create_v2", &args, accounts))
}

/// A vault transaction that runs `instructions` with the vault as their signer.
pub struct VaultTransaction<'v> {
    pub multisig: &'v Address,
    pub index: u64,
    pub proposer: &'v Address,
    pub instructions: &'v [Instruction],
}

impl VaultTransaction<'_> {
    /// Creates the vault transaction and its proposal. The proposer pays their rent.
    pub fn create(&self) -> Result<Vec<Instruction>, String> {
        let message = Message::compile(self.instructions, &vault_address(self.multisig)?)?;
        let args = [&[0u8, 0][..], &borsh_bytes(&message.encode()?)?, &[0]].concat();
        let create = instruction(
            "vault_transaction_create",
            &args,
            vec![
                writable(self.multisig),
                writable(&transaction_address(self.multisig, self.index)?),
                meta(self.proposer, AccountRole::ReadonlySigner),
                meta(self.proposer, AccountRole::WritableSigner),
                readonly(&SYSTEM_PROGRAM),
            ],
        );
        let proposal = instruction(
            "proposal_create",
            &[&self.index.to_le_bytes()[..], &[0]].concat(),
            vec![
                readonly(self.multisig),
                writable(&proposal_address(self.multisig, self.index)?),
                meta(self.proposer, AccountRole::ReadonlySigner),
                meta(self.proposer, AccountRole::WritableSigner),
                readonly(&SYSTEM_PROGRAM),
            ],
        );

        Ok(vec![create, proposal])
    }

    /// Approves the proposal and executes the vault transaction. The proposer must meet the
    /// threshold alone.
    pub fn approve_and_execute(&self) -> Result<Vec<Instruction>, String> {
        let proposal = proposal_address(self.multisig, self.index)?;
        let approve = instruction(
            "proposal_approve",
            &[0],
            vec![readonly(self.multisig), meta(self.proposer, AccountRole::WritableSigner), writable(&proposal)],
        );
        let message = Message::compile(self.instructions, &vault_address(self.multisig)?)?;
        let fixed = [
            readonly(self.multisig),
            writable(&proposal),
            readonly(&transaction_address(self.multisig, self.index)?),
            meta(self.proposer, AccountRole::ReadonlySigner),
        ];
        let execute = instruction(
            "vault_transaction_execute",
            &[],
            fixed.into_iter().chain(message.execute_accounts()).collect(),
        );

        Ok(vec![approve, execute])
    }
}

/// The accounts of a vault transaction, ordered as Squads requires: writable signers, readonly
/// signers, writable non-signers, then readonly non-signers.
struct Message<'m> {
    keys: Vec<AccountMeta>,
    instructions: &'m [Instruction],
}

impl<'m> Message<'m> {
    fn compile(instructions: &'m [Instruction], vault: &Address) -> Result<Self, String> {
        let named = instructions.iter().flat_map(|instruction| {
            instruction
                .accounts
                .iter()
                .copied()
                .chain([AccountMeta { address: instruction.program, role: AccountRole::Readonly }])
        });
        let merged = named.fold(Vec::<AccountMeta>::new(), |mut keys, meta| {
            match keys.iter_mut().find(|key| key.address == meta.address) {
                Some(key) => {
                    key.role = AccountRole::new(
                        key.role.writable() || meta.role.writable(),
                        key.role.signer() || meta.role.signer(),
                    )
                }
                None => keys.push(meta),
            }

            keys
        });

        if merged.iter().any(|key| key.role.signer() && key.address != *vault) {
            return Err("a vault transaction can need only the vault's signature".into());
        }

        let order = |key: &AccountMeta| match (key.role.signer(), key.role.writable()) {
            (true, true) => 0,
            (true, false) => 1,
            (false, true) => 2,
            (false, false) => 3,
        };
        let mut keys = merged;
        keys.sort_by_key(order);

        Ok(Self { keys, instructions })
    }

    fn encode(&self) -> Result<Vec<u8>, String> {
        let count =
            |predicate: fn(&AccountMeta) -> bool| u8::try_from(self.keys.iter().filter(|key| predicate(key)).count());
        let too_many = |_| "a vault transaction names more than 255 accounts".to_owned();
        let header = [
            count(|key| key.role.signer()).map_err(too_many)?,
            count(|key| key.role.signer() && key.role.writable()).map_err(too_many)?,
            count(|key| !key.role.signer() && key.role.writable()).map_err(too_many)?,
        ];
        let keys: Vec<u8> = self.keys.iter().flat_map(|key| key.address.0).collect();
        let instructions = self
            .instructions
            .iter()
            .map(|instruction| self.encode_instruction(instruction))
            .collect::<Result<Vec<_>, _>>()?;

        Ok([
            &header[..],
            &[length_u8(self.keys.len())?],
            &keys,
            &[length_u8(instructions.len())?],
            &instructions.concat(),
            &[0],
        ]
        .concat())
    }

    fn encode_instruction(&self, instruction: &Instruction) -> Result<Vec<u8>, String> {
        let index = |address: &Address| {
            self.keys
                .iter()
                .position(|key| key.address == *address)
                .ok_or("an account is not in the message")
                .and_then(|position| u8::try_from(position).map_err(|_| "an account index exceeds 255"))
        };
        let accounts = instruction.accounts.iter().map(|meta| index(&meta.address)).collect::<Result<Vec<_>, _>>()?;
        let data_len = u16::try_from(instruction.data.len())
            .map_err(|_| "the instruction data exceeds 65,535 bytes".to_owned())?;

        Ok([
            &[index(&instruction.program)?][..],
            &[length_u8(accounts.len())?],
            &accounts,
            &data_len.to_le_bytes(),
            &instruction.data,
        ]
        .concat())
    }

    /// Each message account for `vault_transaction_execute`, with the role that the message gives
    /// it. The vault signs by its seeds, so the transaction marks it as no signer.
    fn execute_accounts(&self) -> impl Iterator<Item = AccountMeta> + '_ {
        self.keys
            .iter()
            .map(|key| AccountMeta { address: key.address, role: AccountRole::new(key.role.writable(), false) })
    }
}

fn length_u8(len: usize) -> Result<u8, String> {
    u8::try_from(len).map_err(|_| "a vault transaction list holds more than 255 items".to_owned())
}

fn instruction(name: &str, args: &[u8], accounts: Vec<AccountMeta>) -> Instruction {
    let digest: [u8; 32] = Sha256::digest(format!("global:{name}").as_bytes()).into();
    let discriminator = digest.get(..8).unwrap_or_default();

    Instruction { program: SQUADS_PROGRAM, accounts, data: [discriminator, args].concat() }
}

fn borsh_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let len = u32::try_from(bytes.len()).map_err(|_| "the message is too long".to_owned())?;

    Ok([&len.to_le_bytes()[..], bytes].concat())
}

fn find(seeds: &[&[u8]]) -> Result<Address, String> {
    sdp_intents_registry_client::find_program_address(seeds, &SQUADS_PROGRAM).map_err(|error| error.to_string())
}

fn meta(address: &Address, role: AccountRole) -> AccountMeta {
    AccountMeta { address: *address, role }
}

fn readonly(address: &Address) -> AccountMeta {
    meta(address, AccountRole::Readonly)
}

fn writable(address: &Address) -> AccountMeta {
    meta(address, AccountRole::Writable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_constant_is_squads() {
        assert_eq!(bs58::encode(SQUADS_PROGRAM.0).into_string(), "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
    }

    /// The vault signs and is writable, so it comes first, and the program comes last.
    #[test]
    fn compiles_a_vault_message() {
        let vault = Address([1; 32]);
        let index = Address([2; 32]);
        let program = Address([3; 32]);
        let instructions = [Instruction {
            program,
            accounts: vec![meta(&index, AccountRole::Writable), meta(&vault, AccountRole::WritableSigner)],
            data: vec![9, 9],
        }];

        let encoded = Message::compile(&instructions, &vault).unwrap().encode().unwrap();

        assert_eq!(&encoded[..4], &[1, 1, 1, 3]);
        assert_eq!(&encoded[4..36], &vault.0);
        assert_eq!(&encoded[36..68], &index.0);
        assert_eq!(&encoded[68..100], &program.0);
        assert_eq!(&encoded[100..], &[1, 2, 2, 1, 0, 2, 0, 9, 9, 0]);
    }

    #[test]
    fn refuses_another_signer_than_the_vault() {
        let instructions = [Instruction {
            program: Address([3; 32]),
            accounts: vec![meta(&Address([4; 32]), AccountRole::ReadonlySigner)],
            data: Vec::new(),
        }];

        assert!(Message::compile(&instructions, &Address([1; 32])).is_err());
    }
}
