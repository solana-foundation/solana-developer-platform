/**
 * Policy candidates for settling and cancelling a DvP trade.
 *
 * A DvP trade is genuinely two-sided, which the policy engine already has a
 * shape for: `legs` carries "per-leg evaluation views of a multi-leg operation"
 * (`packages/sdp-policy/src/ports.ts:32`), the same machinery batch transfers
 * use for their recipients. So both legs are evaluated on their own asset,
 * amount and destination rather than being flattened into one.
 *
 * The top-level candidate describes **SDP's own leg** — what this organization
 * is giving up, and to whom. That is what an amount or destination rule is
 * really asking about, and picking the counterparty's leg instead would let a
 * limit be evaded by labelling the trade the other way round.
 */

import type { PolicyCandidate } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { createDvpTradeRepository, type DvpTradeRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import type { PolicyGateExtraction } from "@/middleware/policy-gate";
import {
  assertFreshApiKeyCustodyWalletAccess,
  getAllowedApiKeyCustodyWalletIdsForPermissions,
} from "@/services/api-key-scope.service";
import type { DvpCloseAction } from "@/services/dvp/settle";
import { getOrCreateDvpSettlementWallet } from "@/services/dvp/settlement-wallet";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import type { Env } from "@/types/env";

interface SettlementWalletRef {
  custodyWalletId: string;
  address: string;
}

/**
 * Builds the policy candidate for closing a trade.
 *
 * @param c - Request context, for the acting principal.
 * @param trade - The trade being closed.
 * @param settlement - The wallet that will sign, which is what policy governs.
 * @param action - settle or cancel; they are separate operation types because
 *   an org may well allow one and not the other.
 */
export function buildDvpClosePolicyCandidate(
  c: Context<{ Bindings: Env }>,
  trade: DvpTradeRow,
  settlement: SettlementWalletRef,
  action: DvpCloseAction
): { candidate: PolicyCandidate; legs: PolicyCandidate[] } {
  const auth = getAuth(c);
  const sdpLegIsA = trade.sdpSide === "a";

  const base = {
    organizationId: auth.organizationId,
    projectId: trade.projectId,
    custodyWalletId: settlement.custodyWalletId,
    walletId: settlement.address,
    apiKeyId: auth.apiKeyId,
    actor: walletOperationActorFromAuth(auth),
    source: "api",
    // The same family Earn uses for its on-chain vault operations. DvP is an
    // interaction with a Solana program, not a payment rail, and reusing it
    // means no migration to widen the wallet_operations family constraint.
    operationFamily: "program" as const,
    operationType: (action === "settle" ? "dvp_settle" : "dvp_cancel") as
      | "dvp_settle"
      | "dvp_cancel",
    providerExtensions: {},
  };

  const legA: PolicyCandidate = {
    ...base,
    asset: trade.mintA,
    amount: trade.amountA,
    // On settle the asset leg goes to user B; on cancel it returns to user A.
    destination: action === "settle" ? trade.userBSettlementDestination : trade.userA,
    context: { dvpTradeId: trade.id, dvpLeg: "a", dvpAction: action },
  };

  const legB: PolicyCandidate = {
    ...base,
    asset: trade.mintB,
    amount: trade.amountB,
    destination: action === "settle" ? trade.userASettlementDestination : trade.userB,
    context: { dvpTradeId: trade.id, dvpLeg: "b", dvpAction: action },
  };

  const sdpLeg = sdpLegIsA ? legA : legB;

  return {
    candidate: {
      ...sdpLeg,
      context: {
        dvpTradeId: trade.id,
        dvpAction: action,
        dvpSdpSide: trade.sdpSide,
        swapDvp: trade.swapDvp,
        counterparty: sdpLegIsA ? trade.userB : trade.userA,
      },
    },
    legs: [legA, legB],
  };
}

/**
 * The policy-gate extractor for `POST /trades/:tradeId/{settle,cancel}`.
 *
 * Resolves the trade and the project's settlement wallet before the gate runs,
 * and hands both to the handler through `resolved` so the work is not repeated
 * after approval. Returns a null candidate when the trade does not exist —
 * `policyGate` treats that as ungoverned and lets the handler produce the 404,
 * rather than filing a wallet operation for a trade that is not there.
 */
export async function extractDvpClosePolicyCandidate(
  c: Context<{ Bindings: Env }>,
  action: DvpCloseAction
): Promise<PolicyGateExtraction> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const tradeId = c.req.param("tradeId") ?? "";

  const trade = await createDvpTradeRepository(c.env).getById(
    {
      organizationId: auth.organizationId,
      projectId,
      // `payments:write`, not read. The routes this extractor serves require
      // write, so filtering by read would hide the trade from a binding that
      // holds write without read — an authorized settle would come back as
      // "trade not found", which is both wrong and impossible to diagnose.
      sdpWalletIds: getAllowedApiKeyCustodyWalletIdsForPermissions(auth, ["payments:write"]),
    },
    tradeId
  );

  if (!trade) {
    return {
      candidate: null,
      legs: [],
      body: {},
      resolved: { trade: null, settlement: null },
      rawPayload: { tradeId },
      idempotencyKey: null,
    };
  }

  // Before the gate records anything. The trade was found through the CACHED
  // auth snapshot, which can be up to an hour stale, so a key revoked inside
  // that window would otherwise get an approval request filed in its name and
  // a settlement wallet provisioned on its behalf. The handler checks this
  // again after approval; both are needed, because only one of them runs on
  // the approved-replay path.
  await assertFreshApiKeyCustodyWalletAccess(getDb(c.env), auth, trade.sdpWalletId, [
    "payments:write",
  ]);

  const settlement = await getOrCreateDvpSettlementWallet(c.env, {
    organizationId: trade.organizationId,
    projectId: trade.projectId,
  });
  const { candidate, legs } = buildDvpClosePolicyCandidate(c, trade, settlement, action);

  return {
    candidate,
    legs,
    body: {},
    resolved: { trade, settlement },
    rawPayload: { tradeId: trade.id, action, swapDvp: trade.swapDvp },
    // The trade id IS the idempotency key: a trade can only be settled or
    // cancelled once, because the instruction closes its account.
    idempotencyKey: `dvp_${action}_${trade.id}`,
  };
}

export interface DvpCloseResolved {
  trade: DvpTradeRow | null;
  settlement: SettlementWalletRef | null;
}
