import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import { type AuditIntent, type AuditLogEntry, AuditService } from "@/services/audit.service";
import type { AppContext } from "../context";

/**
 * Audit-ledger parity for earn money movements (PRO-1866).
 *
 * Every earn money write lands one hash-chained audit event whose actor is
 * the movement row's own attribution (`created_by`/`initiated_by_key_id`),
 * passed explicitly so the two records cannot disagree: the audit feed and
 * the wire-level movement must name the same key or user.
 *
 * The two directions deliberately take different failure postures, the same
 * asymmetry the metered quotas follow (routes/earn/CLAUDE.md):
 *
 * - DEPOSITS are admitted through a fail-closed `beginCritical` intent before
 *   the money side effect, mirroring issuance mint: an audit outage refuses
 *   new money IN, which costs the caller a retry and nothing else. Replays
 *   still produce an intent/outcome pair (the handler cannot tell a replay
 *   from a first send before the service runs); the outcome says `replayed`.
 *   A deposit the service REFUSES closes its intent with a failure outcome:
 *   both deposit services throw only before any broadcast (a send error
 *   returns normally, record-before-broadcast), so an unresolved intent
 *   would page verification over money that never moved. Only the
 *   approved-operation fence leaves an intent unresolved, and that state is
 *   genuinely ambiguous and needs reconciliation.
 * - WITHDRAWALS log best-effort AFTER the money effect. The audit persist
 *   path fail-closes on its external checkpoint store, and a store outage
 *   that 5xxes a customer's way OUT of a position is exactly what ADR 0002
 *   exit safety rules out. The movement ledger row (durable before the
 *   effect) remains the authoritative money record; a failed audit write is
 *   loud (`earn_audit_write_failed`) instead of load-bearing. A REPLAY
 *   normally re-serves an already-audited movement and writes nothing, but a
 *   crash between the money effect and the audit write is repaired on the
 *   retry: a replayed movement with no audit row gets one, marked
 *   `backfilledOnReplay`, so the ledger cannot stay permanently silent about
 *   a movement that exists.
 */

export interface EarnMovementAuditActor {
  organizationId: string;
  userId: string | null;
  apiKeyId: string | null;
}

function earnMovementEntry(
  action: "deposit" | "withdraw",
  actor: EarnMovementAuditActor,
  metadata: Record<string, unknown>,
  resourceId?: string
): AuditLogEntry {
  return {
    organizationId: actor.organizationId,
    // `log()` falls back to the request context for absent actor fields; the
    // movement's own values are passed so a mismatch is unrepresentable.
    userId: actor.userId ?? undefined,
    apiKeyId: actor.apiKeyId ?? undefined,
    action,
    resourceType: "earn_movement",
    ...(resourceId === undefined ? {} : { resourceId }),
    metadata,
  };
}

/**
 * Fail-closed deposit admission. A throw here means the intent was not
 * persisted and the caller must not run the deposit.
 */
export async function beginEarnDepositAudit(
  c: AppContext,
  actor: EarnMovementAuditActor,
  metadata: Record<string, unknown>
): Promise<AuditIntent> {
  return new AuditService(getDb(c.env)).beginCritical(
    c,
    earnMovementEntry("deposit", actor, metadata)
  );
}

/**
 * Outcome for an admitted deposit. Never throws: the money already moved, and
 * `completeCritical` leaves the durable unresolved intent for reconciliation
 * when the outcome write fails.
 */
export async function completeEarnDepositAudit(
  c: AppContext,
  intent: AuditIntent,
  outcome: { resourceId: string; metadata: Record<string, unknown> }
): Promise<void> {
  await new AuditService(getDb(c.env)).completeCritical(c, intent, outcome);
}

/**
 * Close a deposit intent whose service call THREW. Both deposit services
 * throw only before any broadcast, so this is a definitive no-money-moved
 * refusal: recorded as a failure outcome rather than left unresolved, which
 * would page audit-ledger verification over nothing. Never throws.
 */
export async function failEarnDepositAudit(
  c: AppContext,
  intent: AuditIntent,
  error: unknown
): Promise<void> {
  await new AuditService(getDb(c.env)).completeCritical(c, intent, {
    status: "failure",
    metadata: {
      failureReason: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    },
  });
}

/**
 * Best-effort post-effect record for money OUT; never throws (see header).
 *
 * `replayed: true` switches to repair mode: write only when the movement has
 * no audit row yet (the original attempt crashed between the money effect
 * and its audit write), marked `backfilledOnReplay`.
 */
export async function recordEarnWithdrawalAudit(
  c: AppContext,
  actor: EarnMovementAuditActor,
  resourceId: string,
  metadata: Record<string, unknown>,
  options: { replayed?: boolean } = {}
): Promise<void> {
  try {
    let entryMetadata = metadata;
    if (options.replayed) {
      const existing = await getDb(c.env)
        .prepare(
          `SELECT 1 AS present FROM audit_logs
            WHERE organization_id = ? AND action = 'withdraw'
              AND resource_type = 'earn_movement' AND resource_id = ?
            LIMIT 1`
        )
        .bind(actor.organizationId, resourceId)
        .first<{ present: number }>();
      if (existing) return;
      entryMetadata = { ...metadata, backfilledOnReplay: true };
    }
    await new AuditService(getDb(c.env)).log(
      c,
      earnMovementEntry("withdraw", actor, entryMetadata, resourceId)
    );
  } catch (error) {
    getLogger().error(
      {
        event: "earn_audit_write_failed",
        movementId: resourceId,
        organizationId: actor.organizationId,
        error,
      },
      "Earn withdrawal audit record was not persisted; the movement ledger row remains authoritative"
    );
  }
}
