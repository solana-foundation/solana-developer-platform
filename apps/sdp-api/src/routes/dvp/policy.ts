/**
 * Policy candidates for the DvP trade routes.
 *
 * A trade is genuinely two-sided, evaluated through the engine's existing
 * multi-leg `legs` shape. Closing moves BOTH legs and leads with leg A as the
 * representative; funding moves ONE leg — the side the caller named — against
 * the FUNDING organization's own wallet (see {@link extractDvpFundPolicyCandidate}).
 */

import type { PolicyCandidate } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import type { DvpTradeSide } from "@/db/repositories";
import {
  createDvpTradeRepository,
  createPolicyRepository,
  type DvpTradeRow,
} from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  assertFreshApiKeyCustodyWalletAccess,
  getAllowedApiKeyCustodyWalletIdsForPermissions,
} from "@/services/api-key-scope.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { custodyWalletForParty } from "@/services/dvp/custody-party";
import { legOfSide, readDvpLegShortfall } from "@/services/dvp/fund";
import type { DvpCloseAction } from "@/services/dvp/settle";
import { readDvpSettlementWallet } from "@/services/dvp/settlement-wallet";
import { approvedWalletOperationId } from "@/services/policy/approved-operation-replay";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import type { Env } from "@/types/env";
import type { fundDvpTradeSchema } from "./schemas";

interface SettlementWalletRef {
  custodyWalletId: string;
  address: string;
  /** The provider's id for the wallet, which is what `walletId` below means. */
  providerWalletId: string;
}

/**
 * Builds the policy candidate for closing a trade. Settlement is the signing
 * wallet policy governs; settle and cancel stay separate operation types.
 */
export function buildDvpTradeActionPolicyCandidate(
  c: Context<{ Bindings: Env }>,
  trade: DvpTradeRow,
  settlement: SettlementWalletRef,
  action: DvpCloseAction
): { candidate: PolicyCandidate; legs: PolicyCandidate[] } {
  const auth = getAuth(c);

  const base = {
    organizationId: auth.organizationId,
    projectId: trade.projectId,
    custodyWalletId: settlement.custodyWalletId,
    // The PROVIDER's wallet id, not the on-chain address: the ownership check
    // matches `custody_wallets.wallet_id` (`policy.repository.postgres.ts:1044`).
    walletId: settlement.providerWalletId,
    apiKeyId: auth.apiKeyId,
    actor: walletOperationActorFromAuth(auth),
    source: "api",
    // The same family Earn uses for on-chain operations, so the
    // wallet_operations family constraint needs no widening.
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
    // Where this leg's tokens end up: the counterparty on settle, the depositor on cancel.
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

  // Leg A leads as the representative — chosen, not fallen into: the row does
  // not say which leg is the caller's, and both legs are evaluated regardless.
  const legs = [legA, legB];

  return {
    candidate: {
      ...legA,
      context: {
        dvpTradeId: trade.id,
        dvpAction: action,
        swapDvp: trade.swapDvp,
        parties: [trade.userA, trade.userB],
      },
    },
    legs,
  };
}

/**
 * The amount funding is evaluated at: the approved one on a replay, the live
 * per-side shortfall otherwise.
 */
async function approvedOrLiveFundingAmount(
  c: Context<{ Bindings: Env }>,
  trade: DvpTradeRow,
  side: DvpTradeSide
): Promise<bigint> {
  const operationId = approvedWalletOperationId(c);
  if (operationId) {
    const operation = await createPolicyRepository(
      c.env,
      getRequestTenantScope(c)
    ).getWalletOperationById(operationId);
    // A stored row without an amount is not the operation we think it is; let
    // the field-by-field replay match fail loudly downstream.
    if (operation?.amount) {
      return BigInt(operation.amount);
    }
  }
  return readDvpLegShortfall(c.env, trade, side);
}

/**
 * The policy-gate extractor for `POST /trades/:tradeId/{settle,cancel}`.
 *
 * Resolves the trade and the settlement wallet before the gate runs; a missing
 * trade is ungoverned (candidate null) so the handler produces the 404.
 */
export async function extractDvpTradeActionPolicyCandidate(
  c: Context<{ Bindings: Env }>,
  action: DvpCloseAction
): Promise<PolicyGateExtraction> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  // Same reasoning as the fund extractor below: the route always carries
  // :tradeId, so a missing param is a wiring bug, never an empty lookup.
  const tradeId = c.req.param("tradeId");
  if (tradeId === undefined) {
    throw notFound("DvP trade not found");
  }

  const trade = await createDvpTradeRepository(c.env).getById(
    {
      organizationId: auth.organizationId,
      projectId,
      // `payments:write`, not read: a binding holding write without read must
      // still see the trade it is authorized to settle.
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

  // READ, never provision: authorization has not run yet, and a revoked key
  // must not mint a provider wallet as a side effect. Every trade's create
  // already provisioned the settlement authority (it is a PDA seed), so a
  // missing row here is corrupted state, not first use.
  const settlement = await readDvpSettlementWallet(c.env, {
    organizationId: trade.organizationId,
    projectId: trade.projectId,
  });
  if (!settlement) {
    throw notFound("DvP settlement wallet not found for this trade's project");
  }

  // Before the gate records anything: the trade was found through the CACHED
  // auth snapshot (up to an hour stale), so a revoked key would otherwise get
  // an approval filed in its name. The wallet asserted is the SETTLEMENT
  // wallet — the one that signs — and the handler re-asserts after approval
  // because only one of the two checks runs on the approved-replay path.
  await assertFreshApiKeyCustodyWalletAccess(getDb(c.env), auth, settlement.custodyWalletId, [
    "payments:write",
  ]);

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

/** The trade and settlement wallet a close resolved, or neither. */
export type DvpCloseResolved =
  | { trade: DvpTradeRow; settlement: SettlementWalletRef }
  | { trade: null; settlement: null };

/** The trade a fund request resolved, and the wallet that gives the caller the right to fund it. */
export type DvpFundResolved =
  | { trade: null; funding: null }
  | {
      trade: DvpTradeRow;
      funding: { side: DvpTradeSide; custodyWalletId: string; approvedAmount: bigint } | null;
    };

/**
 * The policy-gate extractor for `POST /trades/:tradeId/fund`.
 *
 * One rule for every funder: the right to fund side X is holding an active
 * custody wallet whose public key equals `user_x`. The trade loads WITHOUT
 * project scope — party funding reads another org's row, admitted by RLS 0089
 * (`sdp_dvp_party_read`) only when a wallet of this tenant matches a party
 * address — and policy is evaluated against the FUNDING org's own wallet on
 * the named leg. `idempotencyKey` is deliberately null: top-ups are legal and
 * both sides are separately fundable, so the (trade, side) claim CAS inside
 * the funding path is the serialization, not a key.
 */
export async function extractDvpFundPolicyCandidate(
  c: ValidatedBodyContext<typeof fundDvpTradeSchema>
): Promise<PolicyGateExtraction> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  // The route always carries :tradeId, so a missing param is a wiring bug.
  const tradeId = c.req.param("tradeId");
  if (tradeId === undefined) {
    throw notFound("DvP trade not found");
  }
  const body = c.req.valid("json");

  const absent = (trade: DvpTradeRow | null): PolicyGateExtraction => ({
    candidate: null,
    legs: [],
    body: {},
    resolved: { trade, funding: null },
    rawPayload: { tradeId },
    idempotencyKey: null,
  });

  const trade = await createDvpTradeRepository(c.env).getByIdAsParty(tradeId);
  if (!trade) {
    return absent(null);
  }

  const partyAddress = body.side === "a" ? trade.userA : trade.userB;

  // An explicit `walletId` only narrows: it must be active in scope and hold
  // the named side's party address. Absent, resolve from the party address.
  const custodyWalletId =
    body.walletId !== null && body.walletId !== undefined
      ? await walletIdIfHoldsAddress(c, body.walletId, partyAddress)
      : await custodyWalletForParty(
          c.env,
          { organizationId: auth.organizationId, projectId },
          partyAddress,
          getAllowedApiKeyCustodyWalletIdsForPermissions(auth, ["payments:write"])
        );

  // Ungoverned (candidate null) so the handler produces the 403: filing an
  // operation for a trade this caller has no leg on would pollute their queue.
  if (custodyWalletId === null) {
    return absent(trade);
  }

  // Re-read the binding on the RESOLVED wallet: the gate's auth context can be
  // an hour-old KV snapshot, so a revocation in that window must still bite.
  await assertFreshApiKeyCustodyWalletAccess(getDb(c.env), auth, custodyWalletId, [
    "payments:write",
  ]);

  const wallet = await getDb(c.env)
    .prepare(
      `SELECT w.id AS custody_wallet_id, w.wallet_id
         FROM custody_wallets w
        WHERE w.id = ? AND w.status = 'active'`
    )
    .bind(custodyWalletId)
    .first<{ custody_wallet_id: string; wallet_id: string }>();
  if (!wallet) {
    return absent(trade);
  }

  const leg = legOfSide(trade, body.side);

  // The shortfall, not the target: funding tops a leg up. On an approved
  // REPLAY the stored amount must win — the replay match compares `amount` for
  // exact equality, and a deposit landing in between would shrink a fresh read.
  // Execution treats this pinned amount as a ceiling because ReclaimDvp or a
  // permanent delegate can drain an open escrow after approval.
  const amount = await approvedOrLiveFundingAmount(c, trade, body.side);

  const candidate: PolicyCandidate = {
    organizationId: auth.organizationId,
    projectId,
    custodyWalletId: wallet.custody_wallet_id,
    // The PROVIDER's wallet id, like the close candidate (see base above).
    walletId: wallet.wallet_id,
    apiKeyId: auth.apiKeyId,
    actor: walletOperationActorFromAuth(auth),
    source: "api",
    operationFamily: "program",
    operationType: "dvp_fund",
    providerExtensions: {},
    asset: leg.mint,
    amount: amount.toString(),
    destination: leg.escrow,
    context: {
      dvpTradeId: trade.id,
      dvpAction: "fund",
      dvpLeg: body.side,
      swapDvp: trade.swapDvp,
    },
  };

  return {
    candidate,
    legs: [candidate],
    body: {},
    resolved: { trade, funding: { side: body.side, custodyWalletId, approvedAmount: amount } },
    rawPayload: { tradeId, side: body.side },
    idempotencyKey: null,
  };
}

/**
 * Resolves an explicitly named wallet, but only when it holds the side's
 * party address — naming a wallet narrows and never widens.
 */
export async function walletIdIfHoldsAddress(
  c: Context<{ Bindings: Env }>,
  walletId: string,
  partyAddress: string
): Promise<string | null> {
  const auth = getAuth(c);
  const wallet = await new CustodyRuntimeTargets(
    getDb(c.env),
    c.env,
    new Map()
  ).findOperationalWalletById({
    organizationId: auth.organizationId,
    projectId: requireProjectId(c),
    custodyWalletId: walletId,
  });
  return wallet !== null && wallet.publicKey === partyAddress ? wallet.id : null;
}
