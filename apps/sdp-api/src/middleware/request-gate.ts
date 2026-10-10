import type { Context, MiddlewareHandler, Next } from "hono";
import { internalError } from "@/lib/errors";
import type { Env } from "@/types/env";
import { IDEMPOTENCY_KEY_HEADER } from "./idempotency-key";

type GateContext = Context<{ Bindings: Env }>;

export interface RequestGateExtraction {
  /** The validated request body the handler works from. */
  body: Record<string, unknown>;
  /** Resources the extractor resolved so the handler does not resolve them twice. */
  resolved: unknown;
}

export interface RequestGateConfig {
  /** Validate the request and resolve what the handler needs. Runs first, always. */
  extract: (c: GateContext) => Promise<RequestGateExtraction>;
  /**
   * Answer a request whose Idempotency-Key already has a recorded outcome. A
   * returned response is sent verbatim and the handler never runs; null means
   * this is a new request.
   */
  findIdempotentKeyReplay?: (
    c: GateContext,
    extraction: RequestGateExtraction,
    idempotencyKey: string
  ) => Promise<Response | null>;
  /** Admit genuinely new work, after the replay exit. Throw to refuse it. */
  admit?: (c: GateContext, extraction: RequestGateExtraction) => Promise<void>;
}

export interface RequestGateContext<TBody = unknown, TResolved = unknown> {
  body: TBody;
  resolved: TResolved;
}

/**
 * Run a route's extraction, idempotent-key replay and new-work admission
 * ahead of its handler (ADR 0006). The gate decides nothing about whether the
 * caller may perform the operation: authentication, permissions, the key's
 * wallet binding and its Allowed Operations all run before it.
 *
 * Steps, first exit wins:
 *
 * 1. `extract` — request to validated body and resolved resources.
 * 2. Idempotency-Key present and `findIdempotentKeyReplay` supplied: a matched
 *    recorded outcome returns verbatim, because a replayed request is not a
 *    new request.
 * 3. `admit` — refuse new work the route cannot take.
 * 4. The extraction lands on the context for the handler.
 *
 * @param config - The route's extractor and optional replay finder and admission hook.
 * @returns Hono middleware.
 */
export function requestGate(config: RequestGateConfig): MiddlewareHandler<{ Bindings: Env }> {
  return async (c: GateContext, next: Next) => {
    const extraction = await config.extract(c);

    const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
    if (config.findIdempotentKeyReplay !== undefined && idempotencyKey !== undefined) {
      const replayed = await config.findIdempotentKeyReplay(c, extraction, idempotencyKey);
      if (replayed !== null) {
        return replayed;
      }
    }

    await config.admit?.(c, extraction);

    c.set("requestGate", { body: extraction.body, resolved: extraction.resolved });
    return next();
  };
}

/**
 * Read the context a `requestGate` middleware stashed for the handler,
 * failing loudly when the route is not gated.
 *
 * @param c - Request context.
 * @returns The validated body and the resolved resources.
 */
export function getRequestGateContext<TBody, TResolved>(
  c: GateContext
): RequestGateContext<TBody, TResolved> {
  const context = c.get("requestGate");
  if (context === undefined) {
    throw internalError("Request gate context is unavailable");
  }
  return context as unknown as RequestGateContext<TBody, TResolved>;
}
