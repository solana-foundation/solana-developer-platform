import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { dispatchWorkflowEvent } from "./event-bus";

function logDispatchError(label: string, error: unknown): void {
  getLogger().error(
    { error: error instanceof Error ? error.message : String(error) },
    `${label}: dispatch failed`
  );
}

// onramp_settled / offramp_settled — NOT token-scoped (fiat↔crypto has no asset), so
// rules for these triggers match project-wide. Fire-and-forget off the response path;
// the event key dedupes redelivery, so the webhook and reconciliation paths can both
// emit for one transfer without double-firing rules.
//
// Delivery is at-most-once BY DECISION (Aug 2026): the dispatch is detached, which is
// safe on the Node-only deployment (the process outlives the response and finishes the
// dispatch on the event loop) but would drop triggers on a Workers-style runtime that
// tears down at response time. A durable outbox written in the settlement transaction
// is the planned rework; do not add waitUntil plumbing here in the meantime.
export function emitRampSettled(
  env: Env,
  input: {
    organizationId: string;
    projectId: string;
    direction: "onramp" | "offramp";
    transferId: string;
    provider?: string | null;
    counterpartyId?: string | null;
    amount?: string | null;
    fiatCurrency?: string | null;
    cryptoToken?: string | null;
  }
): void {
  const type = input.direction === "offramp" ? "offramp_settled" : "onramp_settled";
  void dispatchWorkflowEvent(env, {
    type,
    organizationId: input.organizationId,
    projectId: input.projectId,
    eventKey: `${type}:${input.transferId}`,
    payload: {
      transferId: input.transferId,
      provider: input.provider ?? null,
      counterpartyId: input.counterpartyId ?? null,
      amount: input.amount ?? null,
      fiatCurrency: input.fiatCurrency ?? null,
      cryptoToken: input.cryptoToken ?? null,
    },
  }).catch((error) => logDispatchError("emitRampSettled", error));
}

// The guard-facing `attempt` field is an ordinal (1st, 2nd, … failed try for this due
// period), so a rule like "attempt is 3" actually matches. Counted live from the
// attempts table; falls back to 1 if the count can't be resolved.
async function resolveAttemptNumber(
  env: Env,
  input: { subscriptionId: string; dueAt: string; attemptId: string }
): Promise<number> {
  try {
    const row = await getDb(env)
      .prepare(
        `SELECT COUNT(*)::int AS n FROM payment_subscription_collection_attempts
          WHERE subscription_id = ? AND due_at = ?
            AND created_at <= (SELECT created_at FROM payment_subscription_collection_attempts WHERE id = ?)`
      )
      .bind(input.subscriptionId, input.dueAt, input.attemptId)
      .first<{ n: number }>();
    return row && row.n > 0 ? row.n : 1;
  } catch {
    return 1;
  }
}

// recurring_payment_failed — env-based (cron), NOT token-scoped. The attempt id keys
// idempotency so each distinct failed attempt fires once. Best-effort; never throws.
export async function emitRecurringPaymentFailed(
  env: Env,
  input: {
    organizationId: string;
    projectId: string;
    recurringPaymentId: string;
    subscriptionId: string;
    dueAt: string;
    attemptId: string;
    error?: string | null;
  }
): Promise<void> {
  try {
    const attempt = await resolveAttemptNumber(env, input);
    await dispatchWorkflowEvent(env, {
      type: "recurring_payment_failed",
      organizationId: input.organizationId,
      projectId: input.projectId,
      eventKey: `recurring_payment_failed:${input.attemptId}`,
      payload: {
        recurringPaymentId: input.recurringPaymentId,
        attempt,
        attemptId: input.attemptId,
        error: input.error ?? null,
      },
    });
  } catch (error) {
    logDispatchError("emitRecurringPaymentFailed", error);
  }
}
