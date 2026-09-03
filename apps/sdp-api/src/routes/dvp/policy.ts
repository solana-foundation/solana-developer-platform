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
import { createDvpTradeRepository, type DvpTradeRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import type { PolicyGateExtraction } from "@/middleware/policy-gate";
import { getAllowedApiKeyCustodyWalletIdsForPermissions } from "@/services/api-key-scope.service";
import type { DvpCloseAction } from "@/services/dvp/settle";

/** Every trade action that spends from a custody wallet. */
export type DvpTradeAction = DvpCloseAction | "fund";

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
export function buildDvpTradeActionPolicyCandidate(
  c: Context<{ Bindings: Env }>,
  trade: DvpTradeRow,
  settlement: SettlementWalletRef,
  action: DvpTradeAction
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
    operationType: (action === "settle"
      ? "dvp_settle"
      : action === "cancel"
        ? "dvp_cancel"
        : "dvp_fund") as "dvp_settle" | "dvp_cancel" | "dvp_fund",
    providerExtensions: {},
  };

  const legA: PolicyCandidate = {
    ...base,
    asset: trade.mintA,
    amount: trade.amountA,
    // Where this leg's tokens end up: delivered to the counterparty on settle,
    // returned to the depositor on cancel, and INTO the escrow on fund. A
    // destination rule should see the address the money actually reaches.
    destination:
      action === "fund"
        ? trade.escrowA
        : action === "settle"
          ? trade.userBSettlementDestination
          : trade.userA,
    context: { dvpTradeId: trade.id, dvpLeg: "a", dvpAction: action },
  };

  const legB: PolicyCandidate = {
    ...base,
    asset: trade.mintB,
    amount: trade.amountB,
    destination:
      action === "fund"
        ? trade.escrowB
        : action === "settle"
          ? trade.userASettlementDestination
          : trade.userB,
    context: { dvpTradeId: trade.id, dvpLeg: "b", dvpAction: action },
  };

  const sdpLeg = sdpLegIsA ? legA : legB;

  // Funding moves ONE leg — SDP's — so the counterparty's leg is not part of
  // the operation and must not be evaluated as though it were.
  const legs = action === "fund" ? [sdpLeg] : [legA, legB];

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
    legs,
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
export async function extractDvpTradeActionPolicyCandidate(
  c: Context<{ Bindings: Env }>,
  action: DvpTradeAction
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

  const settlement = await getOrCreateDvpSettlementWallet(c.env, {
    organizationId: trade.organizationId,
    projectId: trade.projectId,
  });
  const { candidate, legs } = buildDvpTradeActionPolicyCandidate(c, trade, settlement, action);

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
