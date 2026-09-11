import type { ShieldedAddress } from "@heliuslabs/zolana";
import type { WalletKeys, ZolanaClient } from "@heliuslabs/zolana/client";
import { SPL_TOKEN_PROGRAM_ID } from "@heliuslabs/zolana/interface";
import {
  buildRingEntryTransaction,
  buildRingExitTransaction,
  buildRingTransferTransaction,
  buildRingWithdrawalTransaction,
} from "@heliuslabs/zolana/ring";
import type { Wallet } from "@heliuslabs/zolana/transaction";
import { type Address, address, type Transaction } from "@solana/kit";
import { withConfiguredAddressErrorBridge } from "../error-bridge.js";
import {
  isProtocolNativeMint,
  protocolMint,
  requireProtocolSol,
  requireSpendMint,
} from "./mint.js";

/**
 * Spends of ring-bound notes, through the SDK's one-call ring builders.
 *
 * Unlike the default-pool spends in `spend.ts`, everything happens inside the
 * builder: same-ring note selection, compact change, both proofs, ring
 * encryption, and compression of the finished
 * v0 transaction over the ring's address lookup table. No pinned-input
 * contract and no prepared-intent validation; see docs/ops/helius-rings.md,
 * "Semantics worth knowing".
 *
 * Neither builder is handed `computeUnitLimit`: the default (1.4M, the ring
 * transact verifies two proofs) is exactly the byte-for-byte compute
 * instruction the wire policy expects.
 */

export interface RingSpendDeps {
  readonly client: ZolanaClient;
  readonly wallet: Wallet;
  readonly keys: WalletKeys;
  readonly owner: Address;
}

export interface RingSpendInput {
  /**
   * Ring the operation was pinned to at prepare time. Persisted state rather
   * than caller-echoable input, so a bad value is a config_error and its text
   * never echoes back. Same for the lookup table.
   */
  readonly ringProgramId: string;
  /** The ring's address lookup table, recorded at bring-up; must be ≥1 slot old. */
  readonly lookupTable: string;
  readonly mint: string;
  readonly amountRaw: string;
}

/**
 * The argument set both ring builders share; only the recipient differs.
 *
 * `asset` is always named rather than left to the builder's SOL default, so
 * the mint the caller approved is the one the ring transact binds. An SPL
 * asset also names the legacy Token program: the two mints this build spends
 * are native SOL and devnet USDC, and USDC is not Token-2022.
 */
function ringSpendArgs(deps: RingSpendDeps, input: RingSpendInput) {
  const asset = address(protocolMint(input.mint));

  return {
    client: deps.client,
    ringProgramId: withConfiguredAddressErrorBridge(() => address(input.ringProgramId)),
    wallet: deps.wallet,
    keys: deps.keys,
    feePayer: deps.owner,
    asset,
    amount: BigInt(input.amountRaw),
    lookupTable: withConfiguredAddressErrorBridge(() => address(input.lookupTable)),
  };
}

/** The token program an SPL ring withdrawal settles through, absent for SOL. */
function splTokenProgramFor(mint: string): { splTokenProgram?: Address } {
  return isProtocolNativeMint(mint) ? {} : { splTokenProgram: SPL_TOKEN_PROGRAM_ID };
}

// Both builders stay `async` so the guard's and the address bridge's throws
// surface as rejections, which is the error channel the callers consume.
export async function buildRingWithdrawalTx(
  deps: RingSpendDeps,
  input: RingSpendInput & { recipient: string }
): Promise<Transaction> {
  requireSpendMint(input.mint, "withdrawals");

  return buildRingWithdrawalTransaction({
    ...ringSpendArgs(deps, input),
    ...splTokenProgramFor(input.mint),
    recipient: address(input.recipient),
  });
}

/**
 * The recipient arrives as a full `ShieldedAddress` the caller lifted from
 * material, never a bare Solana address: that keeps same-tenant enforcement
 * upstream and skips the builder's on-chain registry lookup. The recipient's
 * note joins this ring; leaving the ring is a different flow.
 */
export async function buildRingTransferTx(
  deps: RingSpendDeps,
  input: RingSpendInput & { recipient: ShieldedAddress }
): Promise<Transaction> {
  requireSpendMint(input.mint, "transfers");

  return buildRingTransferTransaction({
    ...ringSpendArgs(deps, input),
    recipient: input.recipient,
  });
}

/**
 * Ring → default pool, the wallet's own note on both sides. The recipient is
 * the wallet's OWN lifted `ShieldedAddress`: the builder would accept any
 * recipient, so the self-only rule is this integration's, enforced by the
 * caller passing `material.shieldedAddress` and nothing else. The full address
 * skips the builder's on-chain registry lookup, like the transfer above.
 */
export async function buildRingExitTx(
  deps: RingSpendDeps,
  input: RingSpendInput & { recipient: ShieldedAddress }
): Promise<Transaction> {
  requireProtocolSol(input.mint, "ring exits");

  return buildRingExitTransaction({
    ...ringSpendArgs(deps, input),
    recipient: input.recipient,
  });
}

/**
 * Default pool → ring, self-only by construction: the builder always sends to
 * its own keys' address, so no recipient parameter exists to misuse.
 */
export async function buildRingEntryTx(
  deps: RingSpendDeps,
  input: RingSpendInput
): Promise<Transaction> {
  requireProtocolSol(input.mint, "ring entries");

  return buildRingEntryTransaction(ringSpendArgs(deps, input));
}
