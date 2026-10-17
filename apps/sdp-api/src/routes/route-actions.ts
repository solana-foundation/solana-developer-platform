import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import type { Hono } from "hono";
import { inspectRoutes } from "hono/dev";
// A cycle by design: the app mounts the OpenAPI routes, whose document reads
// this module. `createApp` is only called lazily, never while modules load.
import { createApp } from "@/app";
import {
  parseRouteAuthorizationDeclaration,
  type RouteAuthorizationDeclaration,
} from "@/middleware/require-action";
import { noopObservability } from "@/runtime/observability";
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

/** A route pattern with every parameter name erased, so Hono and OpenAPI paths compare. */
function eraseRouteParameterNames(path: string): string {
  return path.replace(/\{[A-Za-z0-9_]+\}/g, ":_").replace(/:[A-Za-z0-9_]+/g, ":_");
}

let actionsByOperation: ReadonlyMap<string, string> | undefined;

/**
 * The action a documented operation's route declares, for the OpenAPI
 * document's 403 descriptions. Built once, lazily, from the app itself.
 *
 * @param method - Lowercase or uppercase HTTP method.
 * @param openApiPath - An OpenAPI path (`/v1/x/{id}`).
 */
export function declaredActionForOperation(
  method: string,
  openApiPath: string
): string | undefined {
  if (!actionsByOperation) {
    const app = createApp({
      observability: noopObservability,
      rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
    });
    const map = new Map<string, string>();
    for (const route of registeredRouteAuthorizations(app)) {
      const [declaration] = route.declarations;
      if (route.declarations.length === 1 && declaration?.kind === "action") {
        map.set(`${route.method} ${eraseRouteParameterNames(route.path)}`, declaration.action);
      }
    }
    actionsByOperation = map;
  }
  return actionsByOperation.get(`${method.toUpperCase()} ${eraseRouteParameterNames(openApiPath)}`);
}
