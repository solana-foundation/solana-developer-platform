/**
 * A named party funding its own leg of a trade somebody else created.
 *
 * The action half of the flow PRO-1855 opens: discovery ends in "here is the
 * escrow to pay", and without this the only way to pay it is to leave the
 * product and send a transfer by hand — the exact gap the fund endpoint closed
 * for the creating organization.
 *
 * Everything that makes funding safe lives in `executeDvpFunding` and is shared
 * with the original path unchanged: the escrow pre-read, the shortfall rather
 * than the target, the frozen refusal, the re-read before signing, the claim,
 * the approval fence, and the rule that an ambiguous broadcast failure keeps
 * the claim. None of it depends on who is paying, and this file deliberately
 * re-implements none of it.
 *
 * What is different is only the two things that must be:
 *
 * 1. the leg comes from which custody wallet owns the party address, not from
 *    `sdp_side`, which describes the creating org's leg and says nothing about
 *    anyone else's; and
 * 2. the lock lives on `dvp_leg_funding_claims`, keyed by (trade, side) and
 *    owned by the funding organization, so two parties funding opposite legs
 *    cannot collide and no cross-organization write is needed.
 */

import type { Context } from "hono";
import { getDb } from "@/db";
import type { DvpTradeRow } from "@/db/repositories";
import { createPostgresDvpLegFundingClaimRepository } from "@/db/repositories/dvp-leg-funding-claim.repository";
import type { ApiKeyContext } from "@/lib/auth";
import { badRequest, forbidden } from "@/lib/errors";
import type { Env } from "@/types/env";
import { type DvpFundingPlan, type DvpFundResult, executeDvpFunding, legOfSide } from "./fund";
import { type DvpFundableLeg, resolveFundableLeg } from "./fund-authorization";

export interface DvpFundAsPartyRequest {
  organizationId: string;
  projectId: string;
  auth: ApiKeyContext;
}

/** The plan for a party funding the leg its own address is named on. */
export function partyFundingPlan(
  env: Env,
  trade: DvpTradeRow,
  fundable: DvpFundableLeg,
  request: DvpFundAsPartyRequest
): DvpFundingPlan {
  const claims = createPostgresDvpLegFundingClaimRepository(getDb(env));
  return {
    leg: legOfSide(trade, fundable.side),
    signer: {
      organizationId: request.organizationId,
      projectId: request.projectId,
      custodyWalletId: fundable.custodyWalletId,
    },
    claim: (signature, expiryHeight) =>
      claims.claim({
        tradeId: trade.id,
        side: fundable.side,
        organizationId: request.organizationId,
        projectId: request.projectId,
        custodyWalletId: fundable.custodyWalletId,
        signature,
        expiryHeight,
      }),
    release: (signature) => claims.release(trade.id, fundable.side, signature),
    recordFundingTx: (signature) => claims.recordFundingTx(trade.id, fundable.side, signature),
  };
}

/**
 * Funds the caller's own leg.
 *
 * Refuses before any chain read when the caller holds neither party address,
 * because that is an authorization answer and it should not cost an RPC call or
 * a custody-provider round trip to reach it.
 */
export async function fundDvpTradeLegAsParty(
  c: Context<{ Bindings: Env }>,
  trade: DvpTradeRow,
  request: DvpFundAsPartyRequest
): Promise<DvpFundResult> {
  const fundable = await resolveFundableLeg(c.env, trade, request);
  if (fundable === null) {
    // Not "not found": the caller can see this trade, so pretending it does not
    // exist would be a worse answer than the true one. It names two addresses
    // and they hold the key to neither.
    throw forbidden(
      `DvP trade ${trade.id} names no wallet in this project. Only a party to a trade can fund its leg.`
    );
  }

  // The creating organization funds its own leg through the ordinary path,
  // which uses the claim columns on the trade. Routing it here as well would
  // put one leg under two different locks.
  if (trade.tradeKind === "principal" && fundable.side === trade.sdpSide) {
    throw badRequest(
      `DvP trade ${trade.id}: this is your own leg of a trade you created. Fund it through the trade's own funding action.`
    );
  }

  return executeDvpFunding(c, trade, partyFundingPlan(c.env, trade, fundable, request));
}
