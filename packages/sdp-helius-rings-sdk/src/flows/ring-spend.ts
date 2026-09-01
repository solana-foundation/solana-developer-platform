import type { ShieldedAddress } from "@heliuslabs/zolana";
import type { ZolanaClient } from "@heliuslabs/zolana/client";
import {
  buildRingTransferTransaction,
  buildRingWithdrawalTransaction,
} from "@heliuslabs/zolana/ring";
import type { Wallet, WalletAuthority } from "@heliuslabs/zolana/transaction";
import { HeliusRingsError } from "@sdp/helius-rings";
import { type Address, address, type Transaction } from "@solana/kit";
import { withConfiguredAddressErrorBridge } from "../error-bridge.js";
import { PROTOCOL_NATIVE_MINT, protocolMint } from "./mint.js";

/**
 * Spends of ring-bound notes, through the SDK's one-call ring builders.
 *
 * Unlike the default-pool spends in `spend.ts`, everything happens inside the
 * builder: same-ring note selection, compact change, both proofs (the pool
 * transact and the custom-ring proof), encryption via
 * `authority.encryptCustomRingTransfer`, and compression of the finished v0
 * transaction over the ring's address lookup table. That means no pinned-input
 * contract (a rebuild re-selects notes) and no prepared-intent validation (the
 * builder never exposes the prepared transfer); the final-wire policy is the
 * only custody-side check on these bytes.
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

function requireRingSol(mint: string, opType: string): void {
  // Defense in depth behind the route schema's SOL-only literal; parity with
  // the default spend paths. The withdrawal builder would refuse SPL anyway,
  // but the transfer builder would not.
  if (protocolMint(mint) !== PROTOCOL_NATIVE_MINT) {
    throw new HeliusRingsError("invalid_input", `only SOL ${opType}s are supported in this build`);
  }
}

export async function buildRingWithdrawalTx(
  deps: RingSpendDeps,
  input: RingSpendInput & { recipient: string }
): Promise<Transaction> {
  requireRingSol(input.mint, "withdrawal");

  return buildRingWithdrawalTransaction({
    client: deps.client,
    ringProgramId: withConfiguredAddressErrorBridge(() => address(input.ringProgramId)),
    wallet: deps.wallet,
    authority: deps.authority,
    feePayer: deps.owner,
    recipient: address(input.recipient),
    amount: BigInt(input.amountRaw),
    lookupTable: withConfiguredAddressErrorBridge(() => address(input.lookupTable)),
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
  requireRingSol(input.mint, "transfer");

  return buildRingTransferTransaction({
    client: deps.client,
    ringProgramId: withConfiguredAddressErrorBridge(() => address(input.ringProgramId)),
    wallet: deps.wallet,
    authority: deps.authority,
    feePayer: deps.owner,
    recipient: input.recipient,
    amount: BigInt(input.amountRaw),
    lookupTable: withConfiguredAddressErrorBridge(() => address(input.lookupTable)),
  });
}
