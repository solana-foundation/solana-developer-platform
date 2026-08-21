import type { Instruction } from "@solana/kit";
import { SdpKaminoError } from "./errors";

/**
 * Instruction verification for a K-Vault exit.
 *
 * Deliberately OUTSIDE the klend-sdk firewall (`./sdk.ts`): everything here is
 * `@solana/kit` 6.8 over already-built instructions, so share decoding and
 * burn-all rewriting are unit-testable with no 13MB SDK load.
 */

/**
 * The protocol role of one instruction in a withdraw bundle, in execution
 * order: `unstake` frees staked shares, `prepare` is a prerequisite the SDK
 * interleaves (ATA creation), `withdraw` redeems shares (the only role that
 * moves money), `post` is cleanup that must follow every withdraw.
 */
export type WithdrawInstructionRole = "unstake" | "prepare" | "withdraw" | "post";

export interface RoleTaggedInstruction {
  instruction: Instruction;
  role: WithdrawInstructionRole;
  /**
   * Exact shares this instruction redeems, in share-mint BASE UNITS, decoded
   * from the instruction data itself. Null for instructions that redeem
   * nothing (unstake, ATA creation, cleanup).
   */
  sharesBaseUnits: bigint | null;
}

/**
 * Anchor discriminators (sha256("global:<name>")[0..8]) for the two kvault
 * instructions that redeem shares. Both encode `sharesAmount: u64` as their
 * first and only argument, so the exact quantity a withdraw leg moves is
 * decodable from the instruction bytes themselves — no estimate involved.
 * Hardcoded because only `./sdk.ts` may import the SDK; a test pins these
 * against the hash derivation so a protocol rename cannot drift silently.
 */
export const KVAULT_SHARE_REDEEMING_DISCRIMINATORS: readonly Uint8Array[] = [
  // kvault `withdraw` (draws from reserves as needed).
  Uint8Array.from([183, 18, 70, 156, 148, 109, 161, 34]),
  // kvault `withdraw_from_available` (vault-idle liquidity only).
  Uint8Array.from([19, 131, 112, 155, 170, 220, 34, 57]),
];

/**
 * The `sharesAmount` value the kvault program reads as "burn EVERYTHING the
 * share account holds". The SDK encodes it whenever the requested shares are
 * >= the wallet's balance — a full exit never encodes the literal amount.
 */
export const KVAULT_BURN_ALL_SHARES_SENTINEL = 18446744073709551615n;

/**
 * Replace the burn-all sentinel with an exact literal quantity, or refuse.
 *
 * The SDK uses one sentinel on the final reserve leg of a full withdrawal. It
 * means "whatever this token account holds when the transaction executes", so
 * resolving it from a build-time balance would still leave the signed bytes
 * balance-dependent. Instead, derive the exact remainder from the request and
 * the preceding literal legs, then rewrite the instruction's u64 argument.
 * The transaction and the ledger consequently name the same immutable amount.
 */
export function resolveBurnAllSentinel(input: {
  instructions: readonly RoleTaggedInstruction[];
  requestedBaseUnits: bigint;
}): RoleTaggedInstruction[] {
  const sentinelCount = input.instructions.filter(
    (tagged) => tagged.sharesBaseUnits === KVAULT_BURN_ALL_SHARES_SENTINEL
  ).length;
  if (sentinelCount === 0) return [...input.instructions];

  if (sentinelCount !== 1) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      "Kamino withdraw bundle carries more than one burn-all instruction; refusing to build."
    );
  }
  const redeeming = input.instructions.filter((tagged) => tagged.role === "withdraw");
  const sentinelIndex = redeeming.findIndex(
    (tagged) => tagged.sharesBaseUnits === KVAULT_BURN_ALL_SHARES_SENTINEL
  );
  if (sentinelIndex !== redeeming.length - 1) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      "Kamino withdraw bundle places burn-all before a later share redemption; refusing to " +
        "rewrite an order the provider did not document."
    );
  }
  const literalBaseUnits = redeeming.reduce(
    (sum, tagged) =>
      sum +
      (tagged.sharesBaseUnits === KVAULT_BURN_ALL_SHARES_SENTINEL
        ? 0n
        : (tagged.sharesBaseUnits ?? 0n)),
    0n
  );
  const remainder = input.requestedBaseUnits - literalBaseUnits;
  if (remainder <= 0n || remainder > KVAULT_BURN_ALL_SHARES_SENTINEL) {
    throw new SdpKaminoError(
      "INVALID_AMOUNT",
      `Kamino withdraw instructions leave ${remainder} share base units for their final leg; ` +
        "the requested amount must exceed every preceding literal redemption."
    );
  }
  return input.instructions.map((tagged) =>
    tagged.sharesBaseUnits === KVAULT_BURN_ALL_SHARES_SENTINEL
      ? {
          ...tagged,
          instruction: rewriteKvaultWithdrawShares(tagged.instruction, remainder),
          sharesBaseUnits: remainder,
        }
      : tagged
  );
}

function rewriteKvaultWithdrawShares(
  instruction: Instruction,
  sharesBaseUnits: bigint
): Instruction {
  const current = instruction.data;
  if (!current || current.length < 16) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      "Kamino burn-all instruction does not carry a writable sharesAmount argument"
    );
  }
  const data = new Uint8Array(current);
  let remaining = sharesBaseUnits;
  for (let index = 0; index < 8; index += 1) {
    data[8 + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return { ...instruction, data };
}

/**
 * The exact shares one instruction redeems, in share-mint base units — or null
 * when the instruction is not a kvault share-redeeming instruction at all
 * (ATA creation, unstake, cleanup). Reads the `sharesAmount: u64` argument
 * little-endian from the eight bytes after the discriminator.
 */
export function decodeKvaultWithdrawShares(
  instruction: Instruction,
  kvaultProgramAddress: string
): bigint | null {
  if (String(instruction.programAddress) !== kvaultProgramAddress) return null;
  const data = instruction.data;
  if (!data || data.length < 16) return null;
  const matches = KVAULT_SHARE_REDEEMING_DISCRIMINATORS.some((discriminator) =>
    discriminator.every((byte, index) => data[index] === byte)
  );
  if (!matches) return null;
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(data[8 + index] as number);
  }
  return value;
}
