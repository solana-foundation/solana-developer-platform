/**
 * Audit-ledger parity for DvP money movement (PRO-1992).
 *
 * Four DvP actions spend from a custody wallet and none of them left a ledger
 * entry: funding a leg, reclaiming it, and the settle/cancel that close a
 * trade. Each now lands one hash-chained `audit_logs` event naming the same
 * actor the request authenticated as, against `resourceType: "dvp_trade"` and
 * the trade id. A leg has no id of its own on this schema, so the side travels
 * in the metadata rather than in the resource id.
 *
 * The actor is passed explicitly, never left to `log()`'s context fallback:
 * these routes accept an API key, a Clerk session and a dashboard session, and
 * an event that names the wrong principal is worse than no event.
 *
 * The two directions take different failure postures on purpose, the same
 * asymmetry Earn settled on (`routes/earn/CLAUDE.md`, ADR 0002 exit safety):
 *
 * - FUNDING is money IN to the escrow, admitted through a fail-closed
 *   `beginCritical` intent before the transfer. An audit outage refuses the
 *   deposit, which costs the caller a retry and traps nothing: the tokens are
 *   still in their custody wallet. A funding the service REFUSES with a 4xx
 *   closes its intent as a failure, because every fund refusal is raised
 *   before broadcast (`services/dvp/leg-action-idempotency.ts` relies on the
 *   same property to free an idempotency key). Any other throw leaves the
 *   intent UNRESOLVED on purpose: `fundDvpTradeLeg` can fail after a send it
 *   could not classify, and "unresolved" is the signal that sends an operator
 *   to the claim row, where a failure outcome would be a false record.
 * - RECLAIM, SETTLE and CANCEL are exits. They log AFTER the effect and never
 *   throw. The audit write fail-closes on its external checkpoint store, and a
 *   store outage that 5xxes a settle would leave both deposits sitting in
 *   escrow until the trade expires, which is exactly what exit safety rules
 *   out. The trade row and the chain remain the authoritative money record; a
 *   failed write is loud (`dvp_audit_write_failed`) instead of load-bearing.
 *
 * CREATE (SOLA9-614) admits the sponsor-funded broadcast the way funding
 * admits a deposit: a fail-closed `beginCritical` intent after the durable
 * claim wins the idempotency race and before the sponsor signs or the
 * transaction is broadcast, sealed with the authenticated actor, the request
 * id, the idempotency key, the PDA seed tuple, the escrow addresses and the
 * sponsor context. The outcome closes after submission and observation, or as
 * a definitive failure under exactly the predicate that resolves the row
 * `create_failed` — nothing was ever signed, or the send was a preflight
 * rejection the RPC guarantees never reached the network. An ambiguous send
 * leaves the intent unresolved so chain reconciliation, not the mutable
 * `dvp_trades` row, determines the final outcome.
 *
 * Every request that returns a signature logs its own event, including a
 * replay, which is marked `replayed: true`. The alternative, one event per
 * trade and action, would be wrong here: a close whose blockhash expires
 * unseen is retried, and it is the RETRY that lands, so suppressing the second
 * event would leave the ledger pointing at a signature that never executed.
 */

import type { Context } from "hono";
import { getDb } from "@/db";
import { getOptionalAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { type AuditIntent, type AuditLogEntry, AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

/** A DvP exit: the three actions that move value out of an escrow. */
export type DvpExitAuditAction = "reclaim" | "settle" | "cancel";

/** Every DvP action this module records in the audit ledger. */
export type DvpAuditAction = "create" | "fund" | DvpExitAuditAction;

export interface DvpTradeAuditActor {
  organizationId: string;
  userId: string | null;
  apiKeyId: string | null;
}

function dvpTradeEntry(
  action: DvpAuditAction,
  actor: DvpTradeAuditActor | null,
  tradeId: string,
  metadata: Record<string, unknown>
): AuditLogEntry {
  return {
    organizationId: actor?.organizationId,
    // `log()` falls back to the request context for an absent actor field, and
    // a null here becomes `undefined`, so the fallback does run for whichever
    // of the two is null. It cannot name a different principal: both values
    // come from the same normalized auth context, and its key and user
    // contexts are mutually exclusive.
    userId: actor?.userId ?? undefined,
    apiKeyId: actor?.apiKeyId ?? undefined,
    action,
    resourceType: "dvp_trade",
    resourceId: tradeId,
    metadata,
  };
}

/**
 * Reads the audit actor off a request's normalized auth context.
 *
 * @param auth - The context `getAuth` returns.
 * @returns The organization and whichever principal authenticated.
 */
export function dvpTradeAuditActor(auth: {
  organizationId: string;
  userId: string | null;
  apiKeyId: string | null;
}): DvpTradeAuditActor {
  return {
    organizationId: auth.organizationId,
    userId: auth.userId,
    apiKeyId: auth.apiKeyId,
  };
}

/**
 * Fail-closed admission for funding a leg. A throw means the intent was not
 * persisted and the caller must not fund.
 *
 * @param c - Request context.
 * @param actor - The principal the request authenticated as.
 * @param tradeId - The trade being funded.
 * @param metadata - What the intent admits.
 * @returns The durable intent the outcome is appended against.
 */
export async function beginDvpFundAudit(
  c: AppContext,
  actor: DvpTradeAuditActor,
  tradeId: string,
  metadata: Record<string, unknown>
): Promise<AuditIntent> {
  return new AuditService(getDb(c.env)).beginCritical(
    c,
    dvpTradeEntry("fund", actor, tradeId, metadata)
  );
}

/**
 * Outcome for an admitted funding. Never throws: the tokens already moved, and
 * `completeCritical` leaves the unresolved intent for reconciliation when the
 * outcome write fails.
 *
 * @param c - Request context.
 * @param intent - The intent returned by `beginDvpFundAudit`.
 * @param metadata - What the funding did.
 */
export async function completeDvpFundAudit(
  c: AppContext,
  intent: AuditIntent,
  metadata: Record<string, unknown>
): Promise<void> {
  await new AuditService(getDb(c.env)).completeCritical(c, intent, { metadata });
}

/**
 * Conclude a funding intent whose action THREW.
 *
 * A 4xx `AppError` is a definitive pre-broadcast refusal and closes the intent
 * as a failure. Anything else leaves it unresolved, because the transfer may
 * have gone out (see the header). Never throws.
 *
 * @param c - Request context.
 * @param intent - The intent returned by `beginDvpFundAudit`.
 * @param error - Whatever the funding threw.
 */
export async function concludeDvpFundAuditOnError(
  c: AppContext,
  intent: AuditIntent,
  error: unknown
): Promise<void> {
  if (!(error instanceof AppError) || error.statusCode >= 500) {
    return;
  }
  await new AuditService(getDb(c.env)).completeCritical(c, intent, {
    status: "failure",
    metadata: {
      failureReason: error.message.slice(0, 300),
      failureCode: error.code,
    },
  });
}

/**
 * Best-effort post-effect record for a DvP exit; never throws (see header).
 *
 * @param c - Request context.
 * @param actor - The principal the request authenticated as.
 * @param action - Which exit ran.
 * @param tradeId - The trade it ran on.
 * @param metadata - What it did, including the signature.
 */
export async function recordDvpExitAudit(
  c: AppContext,
  actor: DvpTradeAuditActor,
  action: DvpExitAuditAction,
  tradeId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await new AuditService(getDb(c.env)).log(c, dvpTradeEntry(action, actor, tradeId, metadata));
  } catch (error) {
    getLogger().error(
      {
        event: "dvp_audit_write_failed",
        action,
        tradeId,
        organizationId: actor.organizationId,
        error,
      },
      "DvP exit audit record was not persisted; the trade row and the chain remain authoritative"
    );
  }
}

/**
 * Reads the audit actor off a request's normalized auth context without
 * requiring one. The create service runs for every authenticated caller, and
 * the context fallback in `log()` covers whichever principal authenticated —
 * but an explicitly read actor is sealed into the entry, not re-derived at
 * write time.
 *
 * @param c - Request context.
 * @returns The organization and whichever principal authenticated, or null
 *   when the request carried no auth context at all.
 */
export function dvpTradeAuditActorFromContext(c: AppContext): DvpTradeAuditActor | null {
  const auth = getOptionalAuth(c);
  return auth === null ? null : dvpTradeAuditActor(auth);
}

/**
 * Fail-closed admission for creating a trade. A throw means the intent was
 * not persisted and the caller must not sign or broadcast the sponsored
 * transaction (SOLA9-614).
 *
 * @param c - Request context.
 * @param actor - The principal the request authenticated as, when one is
 *   present; null lets the write's context fallback name it.
 * @param tradeId - The trade whose broadcast is being admitted.
 * @param metadata - What the intent admits: idempotency key, PDA seed tuple,
 *   escrow addresses, sponsor context.
 * @returns The durable intent the outcome is appended against.
 */
export async function beginDvpCreateAudit(
  c: AppContext,
  actor: DvpTradeAuditActor | null,
  tradeId: string,
  metadata: Record<string, unknown>
): Promise<AuditIntent> {
  return new AuditService(getDb(c.env)).beginCritical(
    c,
    dvpTradeEntry("create", actor, tradeId, metadata)
  );
}

/**
 * Outcome for an admitted create. Never throws: the transaction is already
 * broadcast, and `completeCritical` leaves the unresolved intent for
 * reconciliation when the outcome write fails.
 *
 * @param c - Request context.
 * @param intent - The intent returned by `beginDvpCreateAudit`.
 * @param metadata - What the create did, including the signature.
 */
export async function completeDvpCreateAudit(
  c: AppContext,
  intent: AuditIntent | null,
  metadata: Record<string, unknown>
): Promise<void> {
  if (intent === null) {
    return;
  }
  await new AuditService(getDb(c.env)).completeCritical(c, intent, { metadata });
}

/**
 * Conclude a create intent whose submission THREW.
 *
 * `definitive` is the caller's already-computed predicate — nothing was ever
 * signed, or the send was a preflight rejection — the same one that resolves
 * the row `create_failed`, so the immutable outcome and the mutable row can
 * only disagree by a lost write, never by a different story. A definitive
 * failure closes the intent; anything else leaves it unresolved because the
 * transaction may be in flight. Never throws.
 *
 * @param c - Request context.
 * @param intent - The intent returned by `beginDvpCreateAudit`, or null when
 *   the refusal happened before admission.
 * @param error - Whatever the submission threw.
 * @param definitive - Whether the create provably never reached the network.
 */
export async function concludeDvpCreateAuditOnError(
  c: AppContext,
  intent: AuditIntent | null,
  error: unknown,
  definitive: boolean
): Promise<void> {
  if (intent === null || !definitive) {
    return;
  }
  await new AuditService(getDb(c.env)).completeCritical(c, intent, {
    status: "failure",
    metadata: {
      failureReason: error instanceof Error ? error.message.slice(0, 300) : String(error),
      failureCode: error instanceof AppError ? error.code : undefined,
    },
  });
}

/**
 * Reads the durable outcome of a trade's create from the immutable ledger.
 *
 * Replay handling consults this because the `dvp_trades` row is mutable: a
 * definitive failure whose row resolution was lost would otherwise wedge the
 * idempotency key on a zombie `creating` row forever.
 *
 * @param env - API process environment.
 * @param organizationId - The creating organization, scoping the read.
 * @param tradeId - The trade whose create outcome to read.
 * @returns The sealed outcome status, or null when the ledger holds no
 *   outcome (an unresolved intent, or a trade created before this record).
 */
export async function findDvpCreateAuditOutcome(
  env: Env,
  organizationId: string,
  tradeId: string
): Promise<"success" | "failure" | null> {
  const outcome = await new AuditService(getDb(env)).findCriticalOutcome({
    organizationId,
    action: "create",
    resourceType: "dvp_trade",
    resourceId: tradeId,
  });
  return outcome?.status ?? null;
}
