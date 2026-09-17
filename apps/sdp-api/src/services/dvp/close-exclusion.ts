/**
 * Keeping a close and a leg action off the same trade at once (PRO-1973).
 *
 * A settle or cancel holds the trade row's close lock; a funding or reclaim
 * holds its leg's row on `dvp_leg_funding_claims`, often in another
 * organization. Neither can write the other's row, so each takes its own lock
 * first and then reads the other's, backing off when it finds one that can
 * still land. Whichever commits its lock second always sees the first, so the
 * two never both go out; at worst both back off and the caller retries.
 */

import type { SolanaRpc } from "@sdp/rpc/solana";
import { DVP_LEG_REFUSAL } from "@sdp/types";
import { createDvpTradeRepository, type DvpCloseClaim } from "@/db/repositories";
import { conflict, notFound } from "@/lib/errors";
import type { Env } from "@/types/env";

/**
 * Whether a close lock can still land at this block height. Past its last valid
 * height the close either landed, and the trade is closed, or never will.
 */
export function isLiveCloseClaim(claim: DvpCloseClaim | null, blockHeight: bigint): boolean {
  return claim !== null && blockHeight <= BigInt(claim.expiryHeight);
}

/**
 * Refuses a leg action on a trade a settle or cancel is closing.
 *
 * Called after the leg's own lock is taken, so a close that locks the trade
 * after this read sees the leg's lock instead. Re-reads the trade rather than
 * trusting the row the request started from, which predates the lock.
 *
 * @throws 409 `dvp_trade_closing` while a close can still land.
 */
export async function assertTradeNotClosing(
  env: Env,
  rpc: SolanaRpc,
  tradeId: string
): Promise<void> {
  const current = await createDvpTradeRepository(env).getByIdAsParty(tradeId);
  if (current === null) {
    throw notFound("DvP trade not found");
  }
  if (current.closeClaim === null) {
    return;
  }
  const blockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
  if (isLiveCloseClaim(current.closeClaim, blockHeight)) {
    throw conflict(
      `DvP trade ${tradeId}: a ${current.closeClaim.action} is in flight on this trade; nothing was sent`,
      { reason: DVP_LEG_REFUSAL.tradeClosing }
    );
  }
}
