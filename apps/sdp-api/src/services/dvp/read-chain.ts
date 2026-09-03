/**
 * Reading a DvP trade's on-chain state.
 *
 * Everything here treats account data as untrusted. `CreateDvp` is
 * permissionless and escrow ATAs derive from (swapDvp, mint, tokenProgram), so
 * an address alone proves nothing about what sits at it — the same reasoning
 * that makes `@sdp/dvp` withhold the generated `fetchSwapDvp` in favour of
 * `verifySwapDvp`. This module extends that discipline to the escrows: owner
 * and size are checked before a single byte is decoded.
 */

import { SwapDvpVerificationError, verifySwapDvp } from "@sdp/dvp";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { type Address, fetchEncodedAccounts } from "@solana/kit";
import { AccountState, getTokenDecoder } from "@solana-program/token-2022";
import { getLogger } from "@/runtime/logger";
import type { DvpLegObservation, DvpTradeObservation } from "./observe";

/**
 * Base SPL token account size. Token-2022 accounts are LONGER (the devnet
 * escrows measure 170 bytes: 165 base, a type discriminator, and extension TLV),
 * so this is a floor, never an equality check. Asserting 165 exactly would
 * reject every Token-2022 escrow this program creates.
 */
const TOKEN_ACCOUNT_MIN_SIZE = 165;

/** A leg's address and the token program that must own its account. */
export interface DvpLegAddress {
  escrow: Address;
  tokenProgram: Address;
}

const MISSING: DvpLegObservation = { exists: false, amount: 0n, frozen: false };

/**
 * Decodes one escrow account, or reports it missing.
 *
 * Refuses to decode anything not owned by the leg's token program or shorter
 * than a token account. A wrong owner is not a corrupt read to work around — it
 * means the address we are about to treat as an escrow holds something else,
 * and reporting its bytes as a balance would be worse than reporting nothing.
 */
function readLeg(
  account: Awaited<ReturnType<typeof fetchEncodedAccounts>>[number],
  leg: DvpLegAddress
): DvpLegObservation {
  if (!account.exists) {
    return MISSING;
  }
  if (account.programAddress !== leg.tokenProgram) {
    getLogger().warn(
      { escrow: account.address, owner: account.programAddress, expected: leg.tokenProgram },
      "dvp reconcile: escrow address is not owned by its token program"
    );
    return MISSING;
  }
  if (account.data.length < TOKEN_ACCOUNT_MIN_SIZE) {
    getLogger().warn(
      { escrow: account.address, size: account.data.length },
      "dvp reconcile: escrow account is too small to be a token account"
    );
    return MISSING;
  }

  const token = getTokenDecoder().decode(account.data);
  return {
    exists: true,
    // The raw u64. Scaling extensions change only the derived UI amount, never
    // this — and it is what the program compares against `amount_x`.
    amount: token.amount,
    frozen: token.state === AccountState.Frozen,
  };
}

/**
 * Reads one escrow, or null when it is not on chain.
 *
 * Exposed for the funding path, which needs a LIVE reading rather than the
 * reconciler's last sweep: that runs once a minute, so two funding requests
 * seconds apart would both believe the escrow was empty and between them
 * over-fund it.
 */
export async function readEscrowState(
  rpc: SolanaRpc,
  escrow: Address,
  tokenProgram: Address
): Promise<{ amount: bigint; frozen: boolean } | null> {
  const [account] = await fetchEncodedAccounts(rpc as never, [escrow]);
  const leg = readLeg(account, { escrow, tokenProgram });
  return leg.exists ? { amount: leg.amount, frozen: leg.frozen } : null;
}

/**
 * Whether a verifiable trade account is at this address.
 *
 * Throws on a transport failure rather than reporting absence. The distinction
 * decides whether the reconciler writes a terminal status or leaves the row for
 * the next sweep, and only one of those is reversible.
 */
async function readTradeAccountExists(rpc: SolanaRpc, swapDvp: Address): Promise<boolean> {
  try {
    await verifySwapDvp(rpc as never, swapDvp);
    return true;
  } catch (error) {
    if (error instanceof SwapDvpVerificationError) {
      // The account is missing, owned by something else, the wrong size, or not
      // at its canonical PDA. All of those are settled facts about the chain.
      return false;
    }
    throw error;
  }
}

/**
 * Reads a trade and both its escrows.
 *
 * @param rpc - Solana RPC for the trade's cluster.
 * @param swapDvp - The trade account address.
 * @param legs - Escrow address and token program for each leg.
 * @param blockHeight - Current block height, read once per sweep by the caller.
 * @returns What the chain shows, ready for `deriveDvpTradeState`.
 */
export async function readDvpTradeObservation(
  rpc: SolanaRpc,
  swapDvp: Address,
  legs: { a: DvpLegAddress; b: DvpLegAddress },
  blockHeight: bigint
): Promise<DvpTradeObservation> {
  // "Absent" and "could not be read" are NOT the same answer, and conflating
  // them is destructive here. `create_failed` and `closed_unknown` are both
  // terminal and both excluded from later sweeps, so a rate-limited or timed-out
  // RPC would permanently misclassify a live trade — the one failure this job
  // can cause that nothing later corrects.
  //
  // A verification failure IS absence: the bytes failed an owner, size or
  // canonical-PDA check, so there is no trade we would act on at that address.
  // A transport failure is not, and it propagates so the caller leaves the row
  // untouched and tries again on the next tick.
  const tradeAccountExists = await readTradeAccountExists(rpc, swapDvp);

  const accounts = await fetchEncodedAccounts(rpc as never, [legs.a.escrow, legs.b.escrow]);

  return {
    tradeAccountExists,
    legA: readLeg(accounts[0], legs.a),
    legB: readLeg(accounts[1], legs.b),
    blockHeight,
  };
}
