/**
 * Who is allowed to fund which leg.
 *
 * This is the whole of PRO-1854's risk and it is not the usual authorization
 * question. Project scope is wrong in BOTH directions here:
 *
 * - it refuses a legitimate funder, because the party holding a leg of an agent
 *   trade is by definition not in the project that created it, and
 * - it would admit anyone in the creating project, including somebody holding
 *   no key for either party address.
 *
 * The right to fund a leg comes from one thing: holding the key to the address
 * that leg names. So the check is whether a custody wallet of the caller's has
 * `public_key` equal to `user_a` or `user_b`, which is the same question
 * discovery asks — deliberately through the same function, so the rule that
 * decides what you can see cannot drift from the rule that decides what you can
 * pay.
 *
 * Note what this is NOT relied upon for: it is the application's answer, and
 * the database has its own. `dvp_trades` is readable across organizations only
 * through the `sdp_dvp_party_read` policy (0089), which applies the same
 * party-address rule in SQL. If this function were wrong, the row would not be
 * readable in the first place.
 */

import type { DvpTradeRow, DvpTradeSide } from "@/db/repositories";
import type { ApiKeyContext } from "@/lib/auth";
import type { Env } from "@/types/env";
import { callerPartyAddresses } from "./inbound";

/** The leg a caller may fund, and the wallet that gives them the right to. */
export interface DvpFundableLeg {
  side: DvpTradeSide;
  /** The caller's wallet whose public key matches the party on that leg. */
  custodyWalletId: string;
  /** That wallet's address, which is the party address on the leg. */
  party: string;
}

export interface DvpFundAuthorizationRequest {
  organizationId: string;
  projectId: string;
  auth: ApiKeyContext;
  /**
   * Which leg the caller means, when they hold both party addresses.
   *
   * Ignored unless they hold it: this narrows a choice they already have and
   * never widens one. Absent, leg A wins.
   */
  preferredSide?: DvpTradeSide;
}

/**
 * The leg this caller holds the key for, or null when they hold neither.
 *
 * An organization can legitimately be BOTH parties to a trade an agent set up
 * for it, and then "the leg they hold" has two answers. Leg A used to win
 * unconditionally, which left leg B unfundable through the product: once A was
 * funded every later request still resolved to A and was refused for having no
 * shortfall. So the caller may name the side, and A remains the default so the
 * answer never depends on map iteration order.
 */
export async function resolveFundableLeg(
  env: Env,
  trade: DvpTradeRow,
  request: DvpFundAuthorizationRequest
): Promise<DvpFundableLeg | null> {
  const addresses = await callerPartyAddresses(env, request);

  const legs: DvpFundableLeg[] = [];
  const walletForA = addresses.get(trade.userA);
  if (walletForA) {
    legs.push({ side: "a", custodyWalletId: walletForA, party: trade.userA });
  }
  const walletForB = addresses.get(trade.userB);
  if (walletForB) {
    legs.push({ side: "b", custodyWalletId: walletForB, party: trade.userB });
  }

  const preferred = request.preferredSide
    ? legs.find((leg) => leg.side === request.preferredSide)
    : undefined;

  return preferred ?? legs[0] ?? null;
}
