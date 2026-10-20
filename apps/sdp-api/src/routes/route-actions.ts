import type { Hono } from "hono";
import { inspectRoutes } from "hono/dev";
import {
  parseRouteAuthorizationDeclaration,
  type RouteAuthorizationDeclaration,
} from "@/middleware/require-action";
import type { Env } from "@/types/env";

export interface RegisteredRouteAuthorization {
  method: string;
  path: string;
  declarations: RouteAuthorizationDeclaration[];
}

/**
 * Every endpoint the app registers, with the authorization declarations in
 * its own handler chain (`requireAction`, `requireActionWhenAuthenticated`,
 * `publicRoute`). A declaration mounted with `.use()` does not count: each
 * route states its own. Read from `hono/dev`'s `inspectRoutes`, like the
 * route-ownership inventory, so no list is kept by hand.
 */
export function registeredRouteAuthorizations(
  app: Hono<{ Bindings: Env }>
): RegisteredRouteAuthorization[] {
  const routes = new Map<string, RegisteredRouteAuthorization>();
  const declarations = new Map<string, RouteAuthorizationDeclaration[]>();
  for (const { method, path, name, isMiddleware } of inspectRoutes(app)) {
    const key = `${method} ${path}`;
    if (!isMiddleware) {
      routes.set(key, { method, path, declarations: [] });
      continue;
    }
    const declaration = parseRouteAuthorizationDeclaration(name);
    if (declaration) {
      declarations.set(key, [...(declarations.get(key) ?? []), declaration]);
    }
  }
  return [...routes.values()].map((route) => ({
    ...route,
    declarations: declarations.get(`${route.method} ${route.path}`) ?? [],
  }));
}

/**
 * An operation's key in the route-action map: the method and the path with
 * every parameter name erased, so a Hono route and its OpenAPI path agree.
 *
 * @param method - HTTP method, either case.
 * @param path - A Hono (`/v1/x/:id`) or OpenAPI (`/v1/x/{id}`) path.
 */
export function routeActionKey(method: string, path: string): string {
  const shape = path.replace(/\{[A-Za-z0-9_]+\}/g, ":_").replace(/:[A-Za-z0-9_]+/g, ":_");
  return `${method.toUpperCase()} ${shape}`;
}

/**
 * The one action each route declares, keyed by {@link routeActionKey}, sorted:
 * what `route-actions.generated.json` holds for the OpenAPI document's 403
 * descriptions. A route with no single action (public, or several) is left out.
 */
export function routeActionsByOperation(app: Hono<{ Bindings: Env }>): Record<string, string> {
  const entries: [string, string][] = [];
  for (const route of registeredRouteAuthorizations(app)) {
    const [declaration] = route.declarations;
    if (route.declarations.length === 1 && declaration?.kind === "action") {
      entries.push([routeActionKey(route.method, route.path), declaration.action]);
    }
  }
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
