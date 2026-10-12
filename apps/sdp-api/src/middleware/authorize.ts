import type { Context, MiddlewareHandler, Next } from "hono";
import { internalError } from "@/lib/errors";
import type { Env } from "@/types/env";

/**
 * A route's access check (HOO-1918, ADR 0008): may this caller act on every
 * resource the request names? It runs after validation and before
 * `idempotent()`, so a replayed request passes exactly the checks a new one
 * does, and nothing after the idempotency step checks access.
 *
 * Access, never state. "This key is bound to the wallet" and "this schedule
 * belongs to the project" belong here; "the wallet is active" and "the schedule
 * is active" stay in the handler. A state check here would refuse the retry of
 * a request that already succeeded (the schedule is active because the first
 * activate worked) instead of replaying its stored answer.
 */

type AuthorizeContext = Context<{ Bindings: Env }>;

/** The validated request, as the route's validators left it. */
export interface AuthorizeInput {
  params: unknown;
  query: unknown;
  body: unknown;
}

/**
 * Checks access and returns what it loaded (the wallet, the schedule) so the
 * handler does not read it again. Throw to refuse.
 */
export type Authorizer<T> = (c: AuthorizeContext, input: AuthorizeInput) => T | Promise<T>;

/** Marks an {@link authorize} handler, for route inventory tests. */
export const AUTHORIZE_MARKER = Symbol.for("sdp.authorize");

export type AuthorizeDeclaration =
  | { kind: "checked" }
  /** The route names no resource beyond the caller's own scope. */
  | { kind: "none"; reason: string };

function validated(c: AuthorizeContext, target: "param" | "query" | "json"): unknown {
  // SAFETY: Hono's `valid` returns whatever the validator for `target` stored,
  // or undefined; the route's own validator decides its shape.
  return (c.req as unknown as { valid(target: string): unknown }).valid(target);
}

/** Reads the validated request a route's validators stored. */
export function validatedInput(c: AuthorizeContext): AuthorizeInput {
  return {
    params: validated(c, "param") ?? c.req.param(),
    query: validated(c, "query"),
    body: validated(c, "json"),
  };
}

/**
 * The route step that runs its access check and stores what it loaded for the
 * handler ({@link getAuthorized}).
 */
export function authorize<T>(check: Authorizer<T>): MiddlewareHandler<{ Bindings: Env }> {
  const middleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next: Next) => {
    const loaded = await check(c, validatedInput(c));
    c.set("authorized", { loaded });
    await next();
  };
  const declaration: AuthorizeDeclaration = { kind: "checked" };
  return Object.assign(middleware, { [AUTHORIZE_MARKER]: declaration });
}

/**
 * For a route that names no resource beyond the caller's own scope (creating a
 * counterparty, screening an address). The reason is pinned by the route
 * inventory, so relying on it is a reviewed decision.
 */
export function authorizeNone(reason: string): MiddlewareHandler<{ Bindings: Env }> {
  const middleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next: Next) => {
    c.set("authorized", { loaded: undefined });
    await next();
  };
  const declaration: AuthorizeDeclaration = { kind: "none", reason };
  return Object.assign(middleware, { [AUTHORIZE_MARKER]: declaration });
}

/** Whether an authorize step ran for this request. */
export function hasAuthorized(c: AuthorizeContext): boolean {
  return c.get("authorized") !== undefined;
}

/** What the route's authorize step loaded, failing loudly when none ran. */
export function getAuthorized<T>(c: AuthorizeContext): T {
  const authorized = c.get("authorized");
  if (authorized === undefined) {
    throw internalError("Route has no authorize step");
  }
  // SAFETY: the route's own authorize step stored this value for its handler.
  return authorized.loaded as T;
}

/** Reads what an {@link authorize} or {@link authorizeNone} handler declares. */
export function declaredAuthorization(handler: unknown): AuthorizeDeclaration | undefined {
  return (handler as { [AUTHORIZE_MARKER]?: AuthorizeDeclaration } | null)?.[AUTHORIZE_MARKER];
}
