import type { Context } from "hono";
import { getLogger } from "@/runtime/logger";
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
    // Start the dispatch BEFORE touching `c.executionCtx`. That getter throws on runtimes
    // without an ExecutionContext (@hono/node-server, i.e. the Cloud Run deployment), and
    // JS evaluates the callee `c.executionCtx.waitUntil` ahead of its arguments — so
    // wrapping the dispatch in the call meant the throw landed before the dispatch ever
    // ran. The catch below then logged it as "emit failed" and the event was gone, which
    // silently disabled every token_operation_completed rule in production.
    const dispatched = dispatchWorkflowEvent(c.env, {
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
      getLogger().error(
        {
          error: error instanceof Error ? error.message : String(error),
          tokenId: input.tokenId,
          operation: input.operation,
        },
        "emitTokenOperationCompleted: dispatch failed"
      );
    });

    try {
      // Workers tear the isolate down at response time, so the promise needs waitUntil to
      // survive. Node has no ExecutionContext and needs nothing: the process outlives the
      // response and finishes the already-running dispatch on the event loop.
      c.executionCtx.waitUntil(dispatched);
    } catch {
      // No ExecutionContext — the dispatch above is already in flight. Nothing to do.
    }
  } catch (error) {
    getLogger().error(
      {
        error: error instanceof Error ? error.message : String(error),
        tokenId: input.tokenId,
        operation: input.operation,
      },
      "emitTokenOperationCompleted: emit failed"
    );
  }
}
