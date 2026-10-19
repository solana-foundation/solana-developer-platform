import type { Context, ContextVariableMap, MiddlewareHandler } from "hono";
import { AppError, forbidden } from "@/lib/errors";
import type { Env } from "@/types/env";

/** The refusal an API key gets on a human-only route. */
export const HUMAN_SESSION_REQUIRED_MESSAGE =
  "This action requires a signed-in user; API keys cannot perform it";

/**
 * Admits only a signed-in person (a Clerk session). API keys are credentials,
 * not administrators: they cannot manage keys, the organization, its members
 * or its invitations, or project members, whatever permissions they carry.
 * Mount it after authentication and before any permission check or handler,
 * so a key is refused before anything reads or writes.
 *
 * @returns Hono middleware that refuses any caller without a Clerk session (403).
 */
export function requireHumanSession(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    requireHumanActor(c);
    await next();
  };
}

/**
 * The signed-in person behind this request, for handlers behind
 * {@link requireHumanSession}.
 *
 * @throws AppError FORBIDDEN when the caller is not a Clerk session.
 */
export function requireHumanActor(
  c: Context<{ Bindings: Env }>
): NonNullable<ContextVariableMap["clerk"]> {
  const clerk = c.get("clerk");
  if (!clerk) {
    if (c.get("apiKey")) {
      throw forbidden(HUMAN_SESSION_REQUIRED_MESSAGE);
    }
    throw new AppError("UNAUTHORIZED", "Authentication required");
  }
  return clerk;
}
