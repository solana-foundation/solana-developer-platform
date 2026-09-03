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

import { verifySwapDvp } from "@sdp/dvp";
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
  // A trade account that fails verification is treated as absent rather than as
  // an error. Both mean the same thing to the caller — there is no trade we are
  // willing to act on at that address — and the alternative is trusting bytes
  // that failed an owner, size or canonical-PDA check.
  const tradeAccountExists = await verifySwapDvp(rpc as never, swapDvp).then(
    () => true,
    () => false
  );

  const accounts = await fetchEncodedAccounts(rpc as never, [legs.a.escrow, legs.b.escrow]);

  return {
    tradeAccountExists,
    legA: readLeg(accounts[0], legs.a),
    legB: readLeg(accounts[1], legs.b),
    blockHeight,
  };
}
