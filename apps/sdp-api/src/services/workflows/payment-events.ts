import type { Context } from "hono";
import type { Env } from "@/types/env";
import { dispatchWorkflowEvent } from "./event-bus";

type AppContext = Context<{ Bindings: Env }>;

function logDispatchError(label: string, error: unknown): void {
  console.error(`${label}: dispatch failed`, {
    error: error instanceof Error ? error.message : String(error),
  });
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
  c.executionCtx.waitUntil(
    dispatchWorkflowEvent(c.env, {
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
    }).catch((error) => logDispatchError("emitRampSettled", error))
  );
}

// recurring_payment_failed — env-based (cron), NOT token-scoped. The attempt id keys
// idempotency so each distinct failed attempt fires once. Best-effort; never throws.
export async function emitRecurringPaymentFailed(
  env: Env,
  input: {
    organizationId: string;
    projectId: string;
    recurringPaymentId: string;
    attemptId: string;
    error?: string | null;
  }
): Promise<void> {
  try {
    await dispatchWorkflowEvent(env, {
      type: "recurring_payment_failed",
      organizationId: input.organizationId,
      projectId: input.projectId,
      eventKey: `recurring_payment_failed:${input.attemptId}`,
      payload: {
        recurringPaymentId: input.recurringPaymentId,
        attempt: input.attemptId,
        error: input.error ?? null,
      },
    });
  } catch (error) {
    logDispatchError("emitRecurringPaymentFailed", error);
  }
}
