import type { Context, MiddlewareHandler, Next } from "hono";
import type { Env } from "@/types/env";
import { type AuthorizeInput, getAuthorized, validatedInput } from "./authorize";
import { parseIdempotencyKey } from "./idempotency-key";

/**
 * The steps between `idempotent()` and a money-moving handler (HOO-1918, ADR
 * 0008), in their fixed order:
 *
 *   authorize → idempotent → replayFromRecord → admit → handler
 *
 * Neither checks access; `authorize` did that before the key was claimed.
 */

type StepContext = Context<{ Bindings: Env }>;

/** The validated request plus what the route's `authorize` step loaded. */
export interface MovementStepInput<TAuthorized> extends AuthorizeInput {
  authorized: TAuthorized;
}

function stepInput<TAuthorized>(c: StepContext): MovementStepInput<TAuthorized> {
  return { ...validatedInput(c), authorized: getAuthorized<TAuthorized>(c) };
}

/**
 * Answers a request whose Idempotency-Key already has a domain row, from that
 * row: after a takeover of a crashed attempt, or past the key's 24 hours. A
 * returned response is sent as-is and nothing runs again; null means the key
 * has no row yet.
 *
 * It works from the validated request and what `authorize` loaded only: no
 * RPC, nothing that can change after the original ran (a token account closed,
 * a counterparty archived), so a request that already ran is always answered.
 * It runs before {@link admit}, so admission never refuses a request that
 * already ran.
 */
export function replayFromRecord<TAuthorized>(
  find: (
    c: StepContext,
    input: MovementStepInput<TAuthorized>,
    idempotencyKey: string
  ) => Promise<Response | null>
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next: Next) => {
    const idempotencyKey = parseIdempotencyKey(c);
    if (idempotencyKey !== undefined) {
      const answered = await find(c, stepInput<TAuthorized>(c), idempotencyKey);
      if (answered !== null) {
        return answered;
      }
    }
    await next();
  };
}

/**
 * Refuses new work the route cannot take now (the organization may not start
 * movements, the custody runtime refuses the wallet, the wallet is inactive).
 * State, not access: it runs after the replay exits, so a request that already
 * ran is never refused here.
 */
export function admit<TAuthorized>(
  check: (c: StepContext, input: MovementStepInput<TAuthorized>) => Promise<void>
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next: Next) => {
    await check(c, stepInput<TAuthorized>(c));
    await next();
  };
}
