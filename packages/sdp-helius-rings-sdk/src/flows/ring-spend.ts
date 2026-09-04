import type { ShieldedAddress } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import {
  buildRingTransferTransaction,
  buildRingWithdrawalTransaction,
} from "@heliuslabs/zolana/ring";
import type { Wallet, WalletAuthority } from "@heliuslabs/zolana/transaction";
import { type Address, address, type Transaction } from "@solana/kit";
import { withConfiguredAddressErrorBridge } from "../error-bridge.js";
import { requireProtocolSol } from "./mint.js";

/**
 * Spends of ring-bound notes, through the SDK's one-call ring builders.
 *
 * Unlike the default-pool spends in `spend.ts`, everything happens inside the
 * builder: same-ring note selection, compact change, both proofs, encryption
 * via `authority.encryptCustomRingTransfer`, and compression of the finished
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
  readonly authority: WalletAuthority;
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

/** The argument set both ring builders share; only the recipient differs. */
function ringSpendArgs(deps: RingSpendDeps, input: RingSpendInput) {
  return {
    client: deps.client,
    ringProgramId: withConfiguredAddressErrorBridge(() => address(input.ringProgramId)),
    wallet: deps.wallet,
    authority: deps.authority,
    feePayer: deps.owner,
    amount: BigInt(input.amountRaw),
    lookupTable: withConfiguredAddressErrorBridge(() => address(input.lookupTable)),
  };
}

// Both builders stay `async` so the guard's and the address bridge's throws
// surface as rejections, which is the error channel the callers consume.
export async function buildRingWithdrawalTx(
  deps: RingSpendDeps,
  input: RingSpendInput & { recipient: string }
): Promise<Transaction> {
  requireProtocolSol(input.mint, "withdrawal");

  return buildRingWithdrawalTransaction({
    ...ringSpendArgs(deps, input),
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
  requireProtocolSol(input.mint, "transfer");

  return buildRingTransferTransaction({
    ...ringSpendArgs(deps, input),
    recipient: input.recipient,
  });
}
