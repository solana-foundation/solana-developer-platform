import { type Action, isApiKeyGrantableAction } from "@sdp/types/actions";
import type { Context, MiddlewareHandler } from "hono";
import { authMayPerform, getOptionalAuth } from "@/lib/auth";
import { AppError, missingAction } from "@/lib/errors";
import { isOrganizationAdmitted, organizationNotAdmitted } from "@/lib/production-entitlement";
import type { Env } from "@/types/env";

/**
 * Route authorization by action (HOO-2099). Every route declares exactly one
 * action with {@link requireAction}, or is marked {@link publicRoute} with the
 * reason no action applies. The declaration is the middleware's function name,
 * which `hono/dev`'s `inspectRoutes` reads back, so the route inventory test
 * (`route-actions.test.ts`) checks every registered route without a second
 * list.
 */

const ACTION_DECLARATION = /^requireAction\(([a-z_]+\.[a-z_]+)\)$/;
const PUBLIC_DECLARATION = /^publicRoute\((.+)\)$/s;

/**
 * Whether the request's caller may perform the action. For a response that
 * mixes two sensitivities, so a handler can check the finer one; false with
 * no caller.
 */
export function callerMayPerform(c: Context<{ Bindings: Env }>, action: Action): boolean {
  const auth = getOptionalAuth(c);
  return auth !== null && authMayPerform(auth, action);
}

/**
 * Refuses the request unless its caller may perform the action: 401 with no
 * caller, 403 naming the action otherwise. An API key is refused an action no
 * key may hold even when its stored grants name it.
 */
export function assertCallerMayPerform(c: Context<{ Bindings: Env }>, action: Action): void {
  const auth = getOptionalAuth(c);
  if (!auth) {
    throw new AppError("UNAUTHORIZED", "Authentication required");
  }
  if (authMayPerform(auth, action)) {
    return;
  }
  if (auth.authType === "api_key" && !isApiKeyGrantableAction(action)) {
    throw new AppError("INSUFFICIENT_PERMISSIONS", `API keys cannot perform ${action}`, {
      action,
    });
  }
  throw missingAction(action);
}

function named(
  name: string,
  middleware: MiddlewareHandler<{ Bindings: Env }>
): MiddlewareHandler<{ Bindings: Env }> {
  Object.defineProperty(middleware, "name", { value: name });
  return middleware;
}

/**
 * What an organization a mainnet-only deployment does not admit may still do: read its own
 * organization, projects (it has none it can see) and members. Two routes go further, each
 * marking itself exempt (`organizationAdmissionExempt`): requesting mainnet access, and the Earn
 * exits and reads a production project keeps after losing the entitlement. Everything else,
 * changing the organization's settings and inviting members included, waits for approval.
 */
const NOT_ADMITTED_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "organizations.read",
  "projects.read",
  "members.read",
]);

/**
 * Refuses an action a mainnet-only deployment keeps from an organization without mainnet access.
 * Runs after the caller is known to hold the action, so a missing grant is still named as such.
 */
function assertOrganizationAdmittedFor(c: Context<{ Bindings: Env }>, action: Action): void {
  if (NOT_ADMITTED_ACTIONS.has(action) || c.get("organizationAdmissionExempt")) return;
  if (!isOrganizationAdmitted(c)) throw organizationNotAdmitted();
}

/**
 * Lets an organization a mainnet-only deployment does not admit through the next
 * {@link requireAction}: for the mainnet-access request, which is how it gets admitted.
 */
export function admitWhileNotApproved(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    c.set("organizationAdmissionExempt", true);
    await next();
  };
}

/**
 * The route's action. Mount it after authentication and before body
 * validation or any handler work, so a refused caller learns nothing about
 * the request and nothing is written.
 */
export function requireAction(action: Action): MiddlewareHandler<{ Bindings: Env }> {
  return named(`requireAction(${action})`, async (c, next) => {
    assertCallerMayPerform(c, action);
    assertOrganizationAdmittedFor(c, action);
    await next();
  });
}

/**
 * Marks a route that no action authorizes, with the reason: it is
 * unauthenticated (health, docs, a signed webhook, a payment link) or
 * authenticated by something other than a tenant's grants (an operator
 * credential, a Clerk session before its organization exists, an invitation
 * token). It does nothing at request time.
 */
export function publicRoute(reason: string): MiddlewareHandler<{ Bindings: Env }> {
  return named(`publicRoute(${reason})`, async (_c, next) => {
    await next();
  });
}

export type RouteAuthorizationDeclaration =
  | { kind: "action"; action: string }
  | { kind: "public"; reason: string };

/** Reads a declaration back from a middleware's name; undefined for any other handler. */
export function parseRouteAuthorizationDeclaration(
  handlerName: string
): RouteAuthorizationDeclaration | undefined {
  const action = ACTION_DECLARATION.exec(handlerName);
  if (action?.[1]) {
    return { kind: "action", action: action[1] };
  }
  const reason = PUBLIC_DECLARATION.exec(handlerName);
  if (reason?.[1]) {
    return { kind: "public", reason: reason[1] };
  }
  return undefined;
}
