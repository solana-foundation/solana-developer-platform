/**
 * Audit-ledger parity for recurring-payment lifecycle broadcasts (APE-888).
 *
 * Activating a recurring payment broadcasts CreatePlan and Subscribe
 * transactions, and cancel/resume broadcast CancelSubscription and
 * ResumeSubscription. Before this module those custody-signed effects were
 * recorded only in mutable recurring-payment/attempt rows: no actor, no
 * request correlation, and no sealed `audit_logs` record, so a completed
 * lifecycle transition left no trace the ledger verifier could detect.
 *
 * Every broadcast is now bracketed by a fail-closed `beginCriticalSystem`
 * intent followed by a `completeCriticalSystem` outcome that seals the
 * resulting Solana signature and the on-chain PDAs. The system path is used
 * for both callers on purpose: recurring lifecycle services run from API
 * requests and from the collection cron, and `logSystem` persists the exact
 * same fail-closed, hash-chained row with the actor and request correlation
 * passed explicitly instead of read off a Hono context the service does not
 * have. A refused intent aborts before any broadcast; a failed outcome write
 * leaves the immutable unresolved intent for verification to page on — it is
 * never rethrown after an effect.
 */

import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { type AuditIntent, AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";

/** Who is driving the lifecycle effect. */
export interface RecurringPaymentAuditActor {
  organizationId: string;
  /** Dashboard identity when a Clerk/session request drives the effect. */
  userId: string | null;
  /** API-key identity when a keyed request drives the effect. */
  apiKeyId: string | null;
  /** Durable X-Request-ID on the request path; the worker correlation ID for cron recovery. */
  requestId: string | null;
}

/** The lifecycle effect a critical intent admits. */
export type RecurringPaymentAuditOperation =
  | "activation_setup"
  | "create_plan"
  | "subscribe"
  | "cancel_subscription"
  | "resume_subscription";

/**
 * Fail-closed admission for a lifecycle broadcast. A throw here means the
 * intent was not persisted and the caller must not broadcast.
 */
export async function beginRecurringPaymentAudit(
  env: Env,
  actor: RecurringPaymentAuditActor,
  operation: RecurringPaymentAuditOperation,
  recurringPaymentId: string,
  metadata: Record<string, unknown> = {}
): Promise<AuditIntent> {
  return new AuditService(getDb(env), createKVStoreSet(env).cache).beginCriticalSystem({
    organizationId: actor.organizationId,
    userId: actor.userId ?? undefined,
    apiKeyId: actor.apiKeyId ?? undefined,
    requestId: actor.requestId ?? undefined,
    action: "submit",
    resourceType: "payment_recurring_payment",
    resourceId: recurringPaymentId,
    metadata: {
      recurringPaymentId,
      recurringPaymentOperation: operation,
      ...metadata,
    },
  });
}

/**
 * Outcome for an admitted lifecycle broadcast. Never throws: the transaction
 * may already be on-chain, and `completeCriticalSystem` leaves the durable
 * unresolved intent for reconciliation when the outcome write fails.
 */
export async function completeRecurringPaymentAudit(
  env: Env,
  intent: AuditIntent,
  outcome: {
    signature: string | null;
    metadata?: Record<string, unknown>;
    status?: "success" | "failure";
  }
): Promise<void> {
  await new AuditService(getDb(env), createKVStoreSet(env).cache).completeCriticalSystem(intent, {
    metadata: { signature: outcome.signature, ...outcome.metadata },
    ...(outcome.status === undefined ? {} : { status: outcome.status }),
  });
}

/**
 * Conclude a lifecycle intent whose service call THREW.
 *
 * A 4xx `AppError` is a definitive pre-broadcast refusal and closes the intent
 * as a failure. Anything else leaves the intent UNRESOLVED on purpose: the
 * effect may have landed (activation and lifecycle confirmations can fail
 * after a successful send), and a failure outcome would be a materially false
 * audit record. Unresolved is the designed signal that pages an operator.
 * Never throws.
 */
export async function concludeRecurringPaymentAuditOnError(
  env: Env,
  intent: AuditIntent,
  error: unknown
): Promise<void> {
  if (!(error instanceof AppError) || error.statusCode >= 500) return;
  await completeRecurringPaymentAudit(env, intent, {
    status: "failure",
    signature: null,
    metadata: {
      failureReason: error.message.slice(0, 300),
      failureCode: error.code,
    },
  });
}
