import type {
  AddressesByLookupTableAddress,
  Blockhash,
  Instruction,
  TransactionSigner,
} from "@solana/kit";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { SdpKaminoError } from "./errors";

/**
 * Transaction-sized batching for a K-Vault exit.
 *
 * Deliberately OUTSIDE the klend-sdk firewall (`./sdk.ts`): everything here is
 * `@solana/kit` 6.8 over already-built instructions, so the batching rules are
 * unit-testable with synthetic instructions and no 13MB SDK load. `sdk.ts`
 * tags each instruction with its protocol role and decoded share quantity;
 * this module only decides where the transaction boundaries fall.
 */

/** Solana's hard packet ceiling for one serialized transaction. */
export const SOLANA_TRANSACTION_SIZE_LIMIT_BYTES = 1232;

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

/** One transaction's worth of an exit, with the exact shares it redeems. */
export interface WithdrawBatch {
  instructions: Instruction[];
  sharesBaseUnits: bigint;
}

/**
 * All-ones base58 decodes to 32 zero bytes — shaped like a real blockhash, so
 * a message can be compiled for MEASUREMENT before any RPC read. Never signed
 * or broadcast; the API fetches a live blockhash when it compiles for real.
 */
const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111" as Blockhash;

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
 * Resolve the burn-all sentinel to an exact quantity, or refuse.
 *
 * A ledger row must state the exact shares its transaction moves, and the
 * sentinel deliberately does not: it moves "whatever the account holds at
 * execution". The one situation where that IS an exact claim is a full exit
 * whose requested quantity equals the wallet's balance as read at build time —
 * then the sentinel and the request name the same shares, and the request is
 * the honest number to record. Everything else is refused:
 *
 * - a request EXCEEDING the balance also encodes the sentinel, but would burn
 *   fewer shares than requested — recording either number would be a lie;
 * - a sentinel beside literal-amount withdraw instructions has no coherent
 *   total at all.
 *
 * Returns the per-instruction base-unit quantities with the sentinel replaced
 * by its resolved value, ready for batching and per-leg ledgering.
 */
export function resolveBurnAllSentinel(input: {
  instructions: readonly RoleTaggedInstruction[];
  requestedBaseUnits: bigint;
  walletShareBaseUnits: bigint;
}): RoleTaggedInstruction[] {
  const sentinelCount = input.instructions.filter(
    (tagged) => tagged.sharesBaseUnits === KVAULT_BURN_ALL_SHARES_SENTINEL
  ).length;
  if (sentinelCount === 0) return [...input.instructions];

  const redeeming = input.instructions.filter((tagged) => tagged.role === "withdraw").length;
  if (sentinelCount !== redeeming) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      "Kamino withdraw bundle mixes burn-all and literal share amounts; refusing to build a " +
        "plan whose total cannot be stated exactly."
    );
  }
  if (sentinelCount !== 1) {
    // Several burn-alls would each claim the whole balance; no exact split exists.
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      "Kamino withdraw bundle carries more than one burn-all instruction; refusing to build."
    );
  }
  if (input.requestedBaseUnits !== input.walletShareBaseUnits) {
    throw new SdpKaminoError(
      "INVALID_AMOUNT",
      `Kamino encodes a full exit for this request, but the wallet holds ` +
        `${input.walletShareBaseUnits} share base units and the request is ` +
        `${input.requestedBaseUnits}. Request at most the position's current share balance; ` +
        "an over-balance request would burn fewer shares than the ledger recorded."
    );
  }
  return input.instructions.map((tagged) =>
    tagged.sharesBaseUnits === KVAULT_BURN_ALL_SHARES_SENTINEL
      ? { ...tagged, sharesBaseUnits: input.requestedBaseUnits }
      : tagged
  );
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

/**
 * The exact wire size one transaction would have: compiled v0 message plus the
 * signature section for its (single) required signer. Uses the same kit
 * compilation the API's signer uses, so a batch measured here cannot compile
 * to a different size there.
 */
export function measureTransactionBytes(input: {
  instructions: readonly Instruction[];
  feePayer: TransactionSigner["address"];
  lookupTables: AddressesByLookupTableAddress;
}): number {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: PLACEHOLDER_BLOCKHASH, lastValidBlockHeight: 0n },
        m
      ),
    (m) => appendTransactionMessageInstructions([...input.instructions], m),
    (m) =>
      Object.keys(input.lookupTables).length > 0
        ? compressTransactionMessageUsingAddressLookupTables(m, input.lookupTables)
        : m
  );
  return getTransactionEncoder().encode(compileTransaction(message)).length;
}

function batchTooLarge(kind: string): SdpKaminoError {
  return new SdpKaminoError(
    "VAULT_UNREADABLE",
    `Kamino withdraw plan cannot be batched: ${kind} exceeds the transaction size budget even ` +
      "with the vault lookup table applied. Refusing to build a plan whose submission would fail."
  );
}

/**
 * Split an ordered withdraw bundle into transaction-sized batches.
 *
 * Instruction ORDER is preserved everywhere — the SDK documents unstake before
 * withdraw before cleanup, and later batches are submitted only after earlier
 * ones land. Two invariants beyond size:
 *
 * - **Every batch carries at least one `withdraw`.** This is the atomicity rule
 *   ("an unstake must never land without its withdraw") stated in its strong
 *   form, and it is also what makes every batch a real money movement the
 *   ledger can record: a leg that redeems zero shares would be unledgerable and
 *   unexplainable. When a prefix (unstake, ATA creation) plus a single withdraw
 *   cannot fit one transaction, the plan is REFUSED rather than weakened.
 * - **Nothing is dropped or reordered to fit.** A single instruction larger
 *   than the budget fails the whole plan; the fix is the lookup table, never
 *   a silent omission.
 *
 * `maxTransactionBytes` is the caller's budget: the packet limit minus the
 * API's reserved headroom (see `EARN_VAULT_TRANSACTION_HEADROOM_BYTES`).
 */
export function planWithdrawBatches(input: {
  instructions: readonly RoleTaggedInstruction[];
  feePayer: TransactionSigner["address"];
  lookupTables: AddressesByLookupTableAddress;
  maxTransactionBytes: number;
}): WithdrawBatch[] {
  const { feePayer, lookupTables, maxTransactionBytes } = input;
  if (input.instructions.length === 0) {
    throw new SdpKaminoError("VAULT_UNREADABLE", "Kamino withdraw bundle carried no instructions");
  }

  const fits = (candidate: readonly RoleTaggedInstruction[]) =>
    measureTransactionBytes({
      instructions: candidate.map((tagged) => tagged.instruction),
      feePayer,
      lookupTables,
    }) <= maxTransactionBytes;

  const closable = (batch: readonly RoleTaggedInstruction[]) =>
    batch.some((tagged) => tagged.role === "withdraw");

  const batches: RoleTaggedInstruction[][] = [];
  let current: RoleTaggedInstruction[] = [];

  for (const tagged of input.instructions) {
    if (fits([...current, tagged])) {
      current.push(tagged);
      continue;
    }
    if (current.length === 0) {
      throw batchTooLarge("a single instruction");
    }
    if (!closable(current)) {
      // Closing here would strand this batch's unstake or preparation work in
      // a transaction that redeems nothing, which the invariant forbids.
      throw batchTooLarge("a transaction that would redeem no shares");
    }
    batches.push(current);
    current = [tagged];
    if (!fits(current)) {
      throw batchTooLarge("a single instruction");
    }
  }
  if (current.length > 0) {
    if (!closable(current)) {
      // A trailing cleanup-only transaction is refused for the same reason:
      // cleanup must ride with the final withdraw or the plan is not built.
      throw batchTooLarge("a transaction that would redeem no shares");
    }
    batches.push(current);
  }

  return batches.map((batch) => ({
    instructions: batch.map((tagged) => tagged.instruction),
    sharesBaseUnits: batch.reduce((sum, tagged) => sum + (tagged.sharesBaseUnits ?? 0n), 0n),
  }));
}
