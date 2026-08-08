import type { Context } from "hono";
import type { Env } from "@/types/env";
import { dispatchWorkflowEvent } from "./event-bus";

type AppContext = Context<{ Bindings: Env }>;

// Fire a `token_operation_completed` workflow event after an on-chain token op confirms.
// Token-scoped (constrains matching to that asset's rules). Fire-and-forget off the
// response path via waitUntil; a dispatch error is logged, never surfaced to the caller.
// NEVER throws — call sites sit after a successful chain op, and an emit problem (e.g.
// a missing ExecutionContext) must not flip that op's transaction to failed.
export function emitTokenOperationCompleted(
  c: AppContext,
  input: {
    organizationId: string;
    projectId: string;
    tokenId: string;
    operation: string;
    signature?: string | null;
    slot?: string | number | null;
    // Fallback idempotency handle when there is no signature (e.g. a DB-only op).
    transactionId?: string | null;
  }
): void {
  try {
    // Signature is unique per confirmed tx → a stable idempotency key. Without one,
    // fall back to the platform transaction id — never a bare (token, operation) pair,
    // which would permanently swallow every later op of the same type on the token.
    const fallback = input.transactionId ?? `${input.tokenId}:${input.operation}:${Date.now()}`;
    const eventKey = `token_operation_completed:${input.signature ?? fallback}`;
    c.executionCtx.waitUntil(
      dispatchWorkflowEvent(c.env, {
        type: "token_operation_completed",
        organizationId: input.organizationId,
        projectId: input.projectId,
        eventKey,
        tokenId: input.tokenId,
        payload: {
          operation: input.operation,
          signature: input.signature ?? null,
          slot: input.slot != null ? String(input.slot) : null,
        },
      }).catch((error) => {
        console.error("emitTokenOperationCompleted: dispatch failed", {
          error: error instanceof Error ? error.message : String(error),
          tokenId: input.tokenId,
          operation: input.operation,
        });
      })
    );
  } catch (error) {
    console.error("emitTokenOperationCompleted: emit failed", {
      error: error instanceof Error ? error.message : String(error),
      tokenId: input.tokenId,
      operation: input.operation,
    });
  }
}
