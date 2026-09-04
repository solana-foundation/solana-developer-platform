import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { SdpKaminoError } from "./errors";
import type { ShareTokenAccountBalance } from "./share-balances";

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
 * first and only argument, so the exact quantity each instruction moves is
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
 * Move enough shares from auxiliary owner accounts into the ATA that kvault
 * always uses as its redemption source. This keeps a multi-account position in
 * one atomic transaction and gives the SDK the post-transfer ATA balance it
 * must use when planning reserve withdrawals.
 */
export async function buildShareAccountConsolidation(input: {
  requestedBaseUnits: bigint;
  shareMint: Address;
  shareDecimals: number;
  owner: TransactionSigner;
  rentPayer?: TransactionSigner;
  accounts: readonly ShareTokenAccountBalance[];
}): Promise<{
  instructions: Instruction[];
  shareAta: Address;
  totalBaseUnits: bigint;
  postConsolidationAtaBaseUnits: bigint;
}> {
  const [shareAta] = await findAssociatedTokenPda({
    owner: input.owner.address,
    mint: input.shareMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const totalBaseUnits = input.accounts.reduce((sum, account) => sum + account.amount, 0n);
  if (totalBaseUnits > KVAULT_BURN_ALL_SHARES_SENTINEL) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      "Kamino share-token balances exceed the mint's u64 supply range."
    );
  }
  if (input.requestedBaseUnits > totalBaseUnits) {
    throw new SdpKaminoError(
      "INVALID_AMOUNT",
      `Kamino wallet holds ${totalBaseUnits} share base units, below the requested ${input.requestedBaseUnits}.`
    );
  }

  const ataBaseUnits = input.accounts
    .filter((account) => account.address === shareAta)
    .reduce((sum, account) => sum + account.amount, 0n);
  let remaining = input.requestedBaseUnits - ataBaseUnits;
  if (remaining <= 0n) {
    return {
      instructions: [],
      shareAta,
      totalBaseUnits,
      postConsolidationAtaBaseUnits: ataBaseUnits,
    };
  }

  const instructions: Instruction[] = [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: input.rentPayer ?? input.owner,
      ata: shareAta,
      owner: input.owner.address,
      mint: input.shareMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
  ];
  for (const account of input.accounts) {
    if (remaining === 0n) break;
    if (account.address === shareAta || account.amount === 0n) continue;
    const amount = account.amount < remaining ? account.amount : remaining;
    instructions.push(
      getTransferCheckedInstruction(
        {
          source: account.address,
          mint: input.shareMint,
          destination: shareAta,
          authority: input.owner,
          amount,
          decimals: input.shareDecimals,
        },
        { programAddress: TOKEN_PROGRAM_ADDRESS }
      )
    );
    remaining -= amount;
  }
  if (remaining !== 0n) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      "Kamino share-token account balances did not cover the requested consolidation."
    );
  }

  return {
    instructions,
    shareAta,
    totalBaseUnits,
    postConsolidationAtaBaseUnits: input.requestedBaseUnits,
  };
}

/**
 * Build an atomic balance assertion for the one amount kvault reserves as its
 * burn-all sentinel. Any auxiliary share accounts are consolidated into the
 * ATA first. SPL Token then validates this same-account transfer completely,
 * including available funds, before returning without changing the balance.
 */
export async function buildMaximumWithdrawalBalanceGuard(input: {
  requestedBaseUnits: bigint;
  shareMint: Address;
  shareDecimals: number;
  owner: TransactionSigner;
}): Promise<Instruction | null> {
  if (input.requestedBaseUnits !== KVAULT_BURN_ALL_SHARES_SENTINEL) return null;
  const [shareAccount] = await findAssociatedTokenPda({
    owner: input.owner.address,
    mint: input.shareMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return getTransferCheckedInstruction(
    {
      source: shareAccount,
      mint: input.shareMint,
      destination: shareAccount,
      authority: input.owner,
      amount: input.requestedBaseUnits,
      decimals: input.shareDecimals,
    },
    { programAddress: TOKEN_PROGRAM_ADDRESS }
  );
}

/**
 * Replace the burn-all sentinel with an exact literal quantity, or refuse.
 *
 * The SDK uses one sentinel on the final redemption instruction of a full withdrawal. It
 * means "whatever this token account holds when the transaction executes", so
 * resolving it from a build-time balance would still leave the signed bytes
 * balance-dependent. Instead, derive the exact remainder from the request and
 * the preceding literal instructions, then rewrite the instruction's u64 argument.
 * The transaction and the ledger consequently name the same immutable amount.
 */
export function resolveBurnAllSentinel(input: {
  instructions: readonly RoleTaggedInstruction[];
  requestedBaseUnits: bigint;
  maximumBalanceGuarded?: boolean;
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
      `Kamino withdraw instructions leave ${remainder} share base units for their final redemption; ` +
        "the remainder must be positive and fit in the protocol's u64 field."
    );
  }
  if (remainder === KVAULT_BURN_ALL_SHARES_SENTINEL && !input.maximumBalanceGuarded) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      "Kamino's maximum-u64 burn-all instruction requires an atomic share-balance guard."
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

/**
 * Give the share ATA's rent back, when and only when this exit empties it.
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 * klend's `withdrawIxs` bundle historically carried no cleanup instructions,
 * so nothing ever closed the share ATA. Its 2,039,280 lamports of
 * rent-exemption stayed locked in an account holding zero shares, for every
 * position ever exited, reclaimable by nobody. That was true before
 * sponsorship and is not caused by it; sponsoring rent only changes who is out
 * the lamports.
 *
 * The pinned SDK (klend-sdk 10.0.0) now emits its OWN CloseAccount on a full
 * exit, in `postWithdrawIxs`, refunding the OWNER unconditionally. SDP still
 * owns the close: the refund destination has to be attribution-aware (rent a
 * sponsor funded goes back to the sponsor, never the owner — migrations
 * 0066/0067), so the plan builder strips the SDK's copy with
 * `isShareAtaCloseInstruction` and this builder appends the single close the
 * plan carries. Two closes on one account cannot both land — SPL CloseAccount
 * fails the second with InvalidAccountData and takes the whole exit with it,
 * which is exactly how the duplication was found.
 *
 * ── Why the condition is exact and not optimistic ─────────────────────────
 * SPL `CloseAccount` FAILS on a non-zero balance, and it rides in the same
 * transaction as the redemptions, so a wrong guess here does not leave rent
 * behind: it fails the customer's exit. The caller therefore passes the two
 * quantities that settle it rather than a boolean. Equality means the account
 * ends at zero, because the redemption instructions are separately asserted to
 * encode exactly `redeemedBaseUnits`. A partial exit returns null and correctly
 * leaves the account open, still holding shares and still holding its rent.
 *
 * `refundTo` must be whoever ACTUALLY funded the account, which for an account
 * that pre-dates this exit is the value recorded when it was created and never a
 * currently-configured sponsor: rent was paid then, the fee mode may have changed
 * since, and refunding "whoever sponsors today" would sooner or later pay a
 * sponsor with the customer's lamports. The caller resolves that; when the exit
 * ITSELF creates the account, the caller passes its own rent payer instead (see
 * `./sdk.ts`), because the recorded value then describes an older instance.
 * Omitted means the owner funded it and keeps it, which is also the correct
 * unsponsored default.
 */
export function buildShareAccountCloseInstruction(input: {
  shareAta: Address;
  owner: TransactionSigner;
  refundTo?: Address;
  /** What the ATA holds once consolidation has run, before any redemption. */
  ataBaseUnitsBeforeExit: bigint;
  /** Shares the redemption instructions are asserted to encode. */
  redeemedBaseUnits: bigint;
  /** Everything the owner holds of this share mint, across every account. */
  ownerTotalBaseUnits: bigint;
}): Instruction | null {
  if (input.ataBaseUnitsBeforeExit !== input.redeemedBaseUnits) return null;
  // A TRUE full exit, not merely an emptied ATA. If auxiliary accounts still
  // hold shares, closing here would be closing an account the very next
  // withdrawal has to recreate and pay rent for again, and the funder recorded
  // against the position would by then describe a previous instance of the
  // account. Leaving it open costs nothing and keeps the recorded funder true.
  if (input.ownerTotalBaseUnits !== input.redeemedBaseUnits) return null;
  return getCloseAccountInstruction(
    {
      account: input.shareAta,
      destination: input.refundTo ?? input.owner.address,
      owner: input.owner,
    },
    { programAddress: TOKEN_PROGRAM_ADDRESS }
  );
}

/** SPL Token `CloseAccount` opcode: one byte, 9. */
const CLOSE_ACCOUNT_OPCODE = 9;

/**
 * Is this the SDK's own close of the share ATA?
 *
 * klend-sdk 10.0.0 closes the emptied share ATA itself on a full exit
 * (`postWithdrawIxs`), refunding the owner unconditionally. SDP owns that
 * close instead (see `buildShareAccountCloseInstruction` above), so the plan
 * builder removes every instruction this predicate matches before appending
 * its own — a plan carrying both would fail on chain, because the second
 * CloseAccount finds an account that no longer exists.
 *
 * Deliberately shape-based and narrow: the token program, the one-byte
 * CloseAccount opcode, and the share ATA as the account being closed. A close
 * of any OTHER account is left alone — it is not SDP's to own, and stripping
 * it would silently change what the SDK asked the chain to do.
 */
export function isShareAtaCloseInstruction(instruction: Instruction, shareAta: Address): boolean {
  if (instruction.programAddress !== TOKEN_PROGRAM_ADDRESS) return false;
  const data = instruction.data;
  if (data?.length !== 1 || data[0] !== CLOSE_ACCOUNT_OPCODE) return false;
  return instruction.accounts?.[0]?.address === shareAta;
}
