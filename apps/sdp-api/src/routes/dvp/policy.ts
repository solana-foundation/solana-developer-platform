/**
 * Policy candidates for the DvP trade routes.
 *
 * A DvP trade is genuinely two-sided, which the policy engine already has a
 * shape for: `legs` carries "per-leg evaluation views of a multi-leg operation"
 * (`packages/sdp-policy/src/ports.ts:32`), the same machinery batch transfers
 * use for their recipients. So both legs are evaluated on their own asset,
 * amount and destination rather than being flattened into one.
 *
 * Closing (settle/cancel) moves BOTH legs, so both are evaluated and the
 * top-level candidate leads with leg A as the representative — chosen, not
 * fallen into. Its context names BOTH parties, which is always true: a trade
 * is two addresses and a settlement authority, and nothing on the row says
 * which (if either) the caller holds.
 *
 * Funding moves ONE leg — the side the caller named — and is evaluated against
 * the FUNDING organization's own wallet by {@link extractDvpFundPolicyCandidate}.
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
import { getOrCreateDvpSettlementWallet } from "@/services/dvp/settlement-wallet";
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
 * Builds the policy candidate for closing a trade.
 *
 * @param c - Request context, for the acting principal.
 * @param trade - The trade being closed.
 * @param settlement - The wallet that will sign, which is what policy governs.
 * @param action - settle or cancel; they are separate operation types because
 *   an org may well allow one and not the other.
 * @returns The top-level candidate and the per-leg evaluation views.
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
    // The PROVIDER's wallet id, not the on-chain address. The wallet-operations
    // ownership check matches `custody_wallets.wallet_id`
    // (`policy.repository.postgres.ts:1044`), so an address finds no row and the
    // operation is refused as belonging to nobody — which surfaced as
    // "Failed to record wallet operation" on every settle and cancel.
    // `payments/handlers/ramps.ts:405-406` is the convention this now matches.
    walletId: settlement.providerWalletId,
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
    // Where this leg's tokens end up: delivered to the counterparty on settle,
    // returned to the depositor on cancel. A destination rule should see the
    // address the money actually reaches.
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

  // Leg A leads — chosen, not fallen into. There is no "our leg" to prefer any
  // more: a trade is two addresses and nothing on the row says which the
  // caller holds, so the representative is a stable convention rather than a
  // claim, and both legs are evaluated below regardless, so nothing escapes
  // policy either way.
  const legs = [legA, legB];

  return {
    candidate: {
      ...legA,
      context: {
        dvpTradeId: trade.id,
        dvpAction: action,
        swapDvp: trade.swapDvp,
        // Naming both parties is always true — a trade is two addresses — so
        // no per-side "counterparty" naming is made up here. The per-side
        // counterparty naming returns in the read paths' derived views.
        parties: [trade.userA, trade.userB],
      },
    },
    legs,
  };
}

/**
 * What funding should be evaluated at: the approved amount on a replay, the
 * live per-side shortfall otherwise.
 *
 * @param c - Request context, which carries the approved operation on a replay.
 * @param trade - The trade whose leg is being funded.
 * @param side - Which leg, by side.
 * @returns The base-unit amount to put on the policy candidate.
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
    // Only when the stored row actually carries an amount. A missing one means
    // this is not the operation we think it is, and the field-by-field match
    // downstream is the right place for that to fail loudly.
    if (operation?.amount) {
      return BigInt(operation.amount);
    }
  }
  return readDvpLegShortfall(c.env, trade, side);
}

/**
 * The policy-gate extractor for `POST /trades/:tradeId/{settle,cancel}`.
 *
 * Resolves the trade and the project's settlement wallet before the gate runs,
 * and hands both to the handler through `resolved` so the work is not repeated
 * after approval. Returns a null candidate when the trade does not exist —
 * `policyGate` treats that as ungoverned and lets the handler produce the 404,
 * rather than filing a wallet operation for a trade that is not there.
 *
 * @param c - Request context.
 * @param action - settle or cancel.
 * @returns The extraction for the gate: candidate, legs, and the resolved
 *   trade and settlement wallet.
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

  // Before the gate records anything. The trade was found through the CACHED
  // auth snapshot, which can be up to an hour stale, so a key revoked inside
  // that window would otherwise get an approval request filed in its name and
  // a settlement wallet provisioned on its behalf. The handler checks this
  // again after approval; both are needed, because only one of them runs on
  // the approved-replay path.
  //
  // The wallet asserted is the SETTLEMENT wallet — for settle and cancel it is
  // the wallet that signs, and the trade row no longer carries a wallet of its
  // own to assert instead. Resolving it first, above, is what makes the id
  // available to assert against.
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
  | { trade: DvpTradeRow; funding: { side: DvpTradeSide; custodyWalletId: string } | null };

/**
 * The policy-gate extractor for `POST /trades/:tradeId/fund`.
 *
 * One extractor for every funder, because there is only one authorization rule
 * left: the right to fund side X is holding an active custody wallet whose
 * public key equals `user_x`. Three things about how it resolves:
 *
 * 1. The trade is loaded WITHOUT project scope. The trade may belong to
 *    somebody else — that is the point of party funding — and the read is
 *    permitted by the `sdp_dvp_party_read` policy (0089), which admits it only
 *    when a custody wallet of this tenant matches a party address, so an
 *    unrelated trade id returns nothing here regardless of what this code
 *    does. Own-tenant reads are held by `sdp_tenant_isolation` (0086). RLS is
 *    the boundary, not this predicate.
 * 2. Policy is evaluated against the FUNDING organization's own wallet. Their
 *    limits and approvals govern their money; the creating org's govern theirs.
 * 3. One leg, the named side. The other leg describes what the counterparty
 *    owes and is no part of this operation.
 *
 * `idempotencyKey` is deliberately null. The old creator path keyed
 * `dvp_fund_${trade.id}`, which pinned one funding per trade forever — but
 * top-ups are legal (funding sends the shortfall, a partly funded leg may be
 * topped up) and both sides of a bilateral trade are separately fundable, so
 * that key would refuse legitimate work. What actually serialises concurrent
 * sends is the (trade, side) claim CAS inside the funding path, which holds
 * exactly while a broadcast is in flight and no longer.
 *
 * @param c - Request context, carrying the validated `{side, walletId?}` body.
 * @returns The extraction for the gate: a per-side candidate, and the resolved
 *   trade plus the funding wallet for the handler. The candidate is null —
 *   ungoverned, with `funding: null` — when the caller holds no wallet on the
 *   named side; the handler produces the 403, and filing a wallet operation
 *   for a trade this caller has no leg on would put somebody else's trade in
 *   their approvals queue.
 */
export async function extractDvpFundPolicyCandidate(
  c: ValidatedBodyContext<typeof fundDvpTradeSchema>
): Promise<PolicyGateExtraction> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  // Typed string | undefined only because the generic Context cannot see the
  // route pattern; the route always carries :tradeId, so a missing param is a
  // wiring bug and must fail loudly rather than resolve to a "" lookup.
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

  // Resolve the funding wallet. An explicit `walletId` only narrows: it must
  // be an active custody wallet in the caller's org/project whose public key
  // equals the named side's party address, and a mismatch or a miss is
  // ungoverned here so the handler can refuse with the real reason. Absent,
  // the wallet is resolved from the party address — the same derivation every
  // other custody-capability question uses.
  const custodyWalletId =
    body.walletId !== null && body.walletId !== undefined
      ? await walletIdIfHoldsAddress(c, body.walletId, partyAddress)
      : await custodyWalletForParty(
          c.env,
          { organizationId: auth.organizationId, projectId },
          partyAddress
        );

  // Ungoverned rather than refused here: the handler produces the 403, and
  // filing a wallet operation for a trade this caller has no leg on would put
  // somebody else's trade in their approvals queue.
  if (custodyWalletId === null) {
    return absent(trade);
  }

  // The gate's auth context is a KV snapshot and can be up to an hour old, so
  // a key whose `payments:write` was revoked in that window would still reach
  // enforcement and sign. Re-read the binding from the database, on the wallet
  // the side RESOLVED to, which is not known until above.
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

  // Funding tops a leg up to its target, so what policy is shown has to be the
  // shortfall rather than the target. Read here, at extraction, because this
  // is the value the approval request stores and a human reads later.
  //
  // On an approved REPLAY the stored amount wins over a fresh read. The replay
  // is checked field-by-field against the approved row with `amount` compared
  // for exact equality (`services/policy/enforcement.service.ts:113`), and a
  // deposit landing between approval and execution would make a fresh read
  // smaller — so recomputing here would fail the match and strand an approved
  // top-up behind a second approval it should never have needed.
  //
  // Pinning is safe in the direction that matters: an escrow only gains tokens
  // while its trade is open, so the live shortfall funding actually sends is
  // always at or below the amount that was approved. Policy approved a ceiling
  // and the transfer stays under it.
  const amount = await approvedOrLiveFundingAmount(c, trade, body.side);

  const candidate: PolicyCandidate = {
    organizationId: auth.organizationId,
    projectId,
    custodyWalletId: wallet.custody_wallet_id,
    // The PROVIDER's wallet id, not the on-chain address — the same convention
    // the close candidate follows and for the same reason (see base above).
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
    resolved: { trade, funding: { side: body.side, custodyWalletId } },
    rawPayload: { tradeId, side: body.side },
    idempotencyKey: null,
  };
}

/**
 * Resolves an explicitly named wallet, but only when it holds the side's
 * party address.
 *
 * @param c - Request context, for the custody target.
 * @param walletId - The custody wallet record id the caller named.
 * @param partyAddress - The named side's party address.
 * @returns The wallet id when it is active in scope and holds the address,
 *   null otherwise — naming a wallet narrows and never widens.
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
