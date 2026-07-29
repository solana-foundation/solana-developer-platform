import type { Context } from "hono";
import type { Env } from "@/types/env";
import { dispatchWorkflowEvent } from "./event-bus";

type AppContext = Context<{ Bindings: Env }>;

// Fire a `token_operation_completed` workflow event after an on-chain token op confirms.
// Token-scoped (constrains matching to that asset's rules). Fire-and-forget off the
// response path via waitUntil; a dispatch error is logged, never surfaced to the caller.
export function emitTokenOperationCompleted(
  c: AppContext,
  input: {
    organizationId: string;
    projectId: string;
    tokenId: string;
    operation: string;
    signature?: string | null;
    slot?: string | number | null;
  }
): void {
  // Signature is unique per confirmed tx → a stable idempotency key.
  const eventKey = `token_operation_completed:${input.signature ?? `${input.tokenId}:${input.operation}`}`;
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
}
