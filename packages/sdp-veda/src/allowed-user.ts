import { AccountRole, type Address, address, type Instruction } from "@solana/kit";

/**
 * The per-user account Veda's deposit creates, and the prefund that pays for
 * it under sponsorship.
 *
 * `boring_vault_svm`'s `deposit` lazily creates the depositor's `AllowedUser`
 * PDA on a wallet's FIRST deposit into a vault: a System `createAccount` CPI
 * whose lamports come from the SIGNER, hardcoded by the program's account
 * table (one signer, no payer knob), and emitted even with the vault's
 * compliance mode off. That is rent the ATA payer swap in `./rent.ts` cannot
 * reach: it happens inside the vault program's own CPI, not in a top-level
 * ATA create. A custody wallet deliberately holding zero SOL therefore failed
 * its first deposit in simulation even with the fee and the ATA rent
 * sponsored (measured on smoky 2026-09-02: `Transfer: insufficient lamports
 * 0, need 1171605` inside the deposit instruction).
 *
 * The mechanism here is a PREFUND, not a payer swap: when the plan is
 * sponsored and the AllowedUser account does not exist yet, the build
 * prepends one System transfer of exactly that account's rent-exempt minimum
 * from the sponsor to the owner, which the program's create consumes in the
 * same transaction, so the owner nets zero. The sponsor signs nothing new: it
 * is already the transaction fee payer, and one `signAsFeePayer` covers the
 * transfer's source account too. Prepending never disturbs a protected
 * instruction group: groups stay contiguous, and the program's own
 * sysvar-relative checks are unaffected by instructions in front of them.
 *
 * Known residual, accepted: if something else creates the AllowedUser account
 * between build and execution, the program's idempotent create is skipped and
 * the owner keeps the prefund as dust, bounded by one 57-byte account's rent
 * and by how rarely one wallet's first deposits race each other.
 *
 * The three constants below are ABI facts about the deployed program, pinned
 * to the committed IDL by `allowed-user.test.ts` exactly as
 * `idl-layout.test.ts` pins `@sdp/earn`'s offset table: if Veda ships a
 * different ABI, a test fails before a build misreads an account.
 */

/** Anchor discriminator of `boring_vault_svm`'s `deposit` instruction. */
export const VEDA_DEPOSIT_DISCRIMINATOR: readonly number[] = [242, 35, 198, 137, 82, 225, 242, 182];

/** Position of `allowed_user` in the deposit instruction's account table. */
export const VEDA_DEPOSIT_ALLOWED_USER_ACCOUNT_INDEX = 14;

/**
 * Size in bytes of the `AllowedUser` account the deposit may create: the
 * 8-byte Anchor discriminator plus the struct fields in the committed IDL.
 * The prefund is sized from THIS number via a live rent read, never from a
 * hardcoded lamport figure — rent parameters are cluster state.
 */
export const VEDA_ALLOWED_USER_ACCOUNT_SIZE = 57;

const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");

/** The System program's `Transfer` instruction index, u32 little-endian. */
const SYSTEM_TRANSFER_INSTRUCTION = 2;

function isVedaDepositInstruction(instruction: Instruction, vaultProgram: Address): boolean {
  if (instruction.programAddress !== vaultProgram) return false;
  const data = instruction.data;
  if (data === undefined || data.length < VEDA_DEPOSIT_DISCRIMINATOR.length) return false;
  return VEDA_DEPOSIT_DISCRIMINATOR.every((byte, index) => data[index] === byte);
}

/**
 * The `allowed_user` account the plan's deposit instruction names, read from
 * the instruction itself (same rule as `createdAtaAddressForMint`): the
 * answer is about the plan that will execute, not PDA arithmetic this package
 * repeats. Undefined when the plan carries no recognizable deposit
 * instruction.
 */
export function allowedUserAccountForDeposit(
  instructions: readonly Instruction[],
  vaultProgram: Address
): Address | undefined {
  for (const instruction of instructions) {
    if (!isVedaDepositInstruction(instruction, vaultProgram)) continue;
    return instruction.accounts?.[VEDA_DEPOSIT_ALLOWED_USER_ACCOUNT_INDEX]?.address;
  }
  return undefined;
}

/**
 * One System transfer of `lamports` from `rentPayer` to `owner`: the prefund
 * a sponsored first deposit prepends. Plain instruction data with no signer
 * objects: the paymaster supplies the payer's signature after compilation,
 * exactly as on the ATA payer swap.
 */
export function prefundOwnerRentInstruction(
  rentPayer: Address,
  owner: Address,
  lamports: bigint
): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, SYSTEM_TRANSFER_INSTRUCTION, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: rentPayer, role: AccountRole.WRITABLE_SIGNER },
      { address: owner, role: AccountRole.WRITABLE },
    ],
    data,
  };
}
