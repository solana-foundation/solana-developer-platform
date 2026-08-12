import type { Context } from "hono";
import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { dispatchWorkflowEvent } from "./event-bus";

type AppContext = Context<{ Bindings: Env }>;

function logDispatchError(label: string, error: unknown): void {
  getLogger().error(
    { error: error instanceof Error ? error.message : String(error) },
    `${label}: dispatch failed`
  );
}

// onramp_settled / offramp_settled — NOT token-scoped (fiat↔crypto has no asset), so
// rules for these triggers match project-wide. Fire-and-forget off the response path.
export function emitRampSettled(
  c: AppContext,
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
  // Start the dispatch BEFORE touching `c.executionCtx`. That getter throws on runtimes
  // without an ExecutionContext (@hono/node-server, i.e. the Cloud Run deployment), and
  // JS evaluates the callee `c.executionCtx.waitUntil` ahead of its arguments — so doing
  // this inline meant the throw landed before the dispatch ever ran. The caller commits
  // the transfer as terminal first, so the provider's retry short-circuits and the
  // settlement trigger was lost for good.
  const dispatched = dispatchWorkflowEvent(c.env, {
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

  try {
    // Workers tear the isolate down at response time, so the promise needs waitUntil to
    // survive. Node has no ExecutionContext and needs nothing: the process outlives the
    // response and finishes the already-running dispatch on the event loop.
    c.executionCtx.waitUntil(dispatched);
  } catch {
    // No ExecutionContext — the dispatch above is already in flight. Nothing to do.
  }
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
