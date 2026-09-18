import { AccountRole, type Address, type Instruction } from "@solana/kit";

/** Anchor discriminator for `boring_onchain_queue::request_withdraw`. */
export const VEDA_REQUEST_WITHDRAW_DISCRIMINATOR: readonly number[] = [
  137, 95, 187, 96, 250, 138, 31, 182,
];

/** Anchor discriminator for `boring_onchain_queue::setup_user_withdraw_state`. */
export const VEDA_SETUP_USER_WITHDRAW_STATE_DISCRIMINATOR: readonly number[] = [
  105, 154, 55, 232, 156, 127, 164, 235,
];

/** Account-table positions pinned to the committed queue IDL. */
export const VEDA_REQUEST_WITHDRAW_OWNER_ACCOUNT_INDEX = 0;
export const VEDA_REQUEST_WITHDRAW_REQUEST_ACCOUNT_INDEX = 5;

/** Eight-byte Anchor discriminator plus the committed struct fields. */
export const VEDA_USER_WITHDRAW_STATE_ACCOUNT_SIZE = 16;
export const VEDA_WITHDRAW_REQUEST_ACCOUNT_SIZE = 120;

function matchesInstruction(
  instruction: Instruction,
  program: Address,
  discriminator: readonly number[]
): boolean {
  if (instruction.programAddress !== program) return false;
  const data = instruction.data;
  if (data === undefined || data.length < discriminator.length) return false;
  return discriminator.every((byte, index) => data[index] === byte);
}

/**
 * Read the deterministic request PDA from the plan that will execute. The
 * owner check prevents a structurally valid instruction for another signer
 * from being presented as this caller's request identity.
 */
export function queuedWithdrawalRequestAddress(
  instructions: readonly Instruction[],
  queueProgram: Address,
  owner: Address
): Address | undefined {
  let request: Address | undefined;
  for (const instruction of instructions) {
    if (!matchesInstruction(instruction, queueProgram, VEDA_REQUEST_WITHDRAW_DISCRIMINATOR)) {
      continue;
    }
    const accounts = instruction.accounts ?? [];
    const signer = accounts[VEDA_REQUEST_WITHDRAW_OWNER_ACCOUNT_INDEX];
    const requestAccount = accounts[VEDA_REQUEST_WITHDRAW_REQUEST_ACCOUNT_INDEX];
    if (signer?.address !== owner || signer.role !== AccountRole.WRITABLE_SIGNER) continue;
    if (requestAccount?.role !== AccountRole.WRITABLE) return undefined;
    const candidate = requestAccount.address;
    if (candidate === undefined || request !== undefined) return undefined;
    request = candidate;
  }
  return request;
}

/**
 * Account sizes whose rent the queue program charges to the owner internally.
 * The request PDA is always new. The per-user state is present only when the
 * SDK emitted its one-time setup instruction.
 */
export function queuedWithdrawalOwnerFundedAccountSizes(
  instructions: readonly Instruction[],
  queueProgram: Address,
  owner: Address
): readonly number[] {
  const hasRequest =
    queuedWithdrawalRequestAddress(instructions, queueProgram, owner) !== undefined;
  if (!hasRequest) return [];

  const createsUserState = instructions.some((instruction) => {
    if (
      !matchesInstruction(instruction, queueProgram, VEDA_SETUP_USER_WITHDRAW_STATE_DISCRIMINATOR)
    ) {
      return false;
    }
    const signer = instruction.accounts?.[0];
    return signer?.address === owner && signer.role === AccountRole.WRITABLE_SIGNER;
  });

  return [
    ...(createsUserState ? [VEDA_USER_WITHDRAW_STATE_ACCOUNT_SIZE] : []),
    VEDA_WITHDRAW_REQUEST_ACCOUNT_SIZE,
  ];
}
