import {
  SDP_RAMP_PROVIDER_STAGES,
  SDP_RELEASE_CHANNELS,
  type SdpModule,
} from "@sdp/types/release-channels";
import { createApp } from "@/app";
import type { RouteHandler } from "@/middleware/authorize";
import { routeOwnerOf } from "@/routes/route-modules";

const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const STABLE_MODULES: ReadonlySet<SdpModule> = new Set(SDP_RELEASE_CHANNELS.stable);

/** One step (middleware or handler) in a stable module's mutating route chain. */
export interface StableMutatingRouteStep {
  /** `METHOD /path`, the key the route inventories pin. */
  route: string;
  /** The step's position across the whole app, so steps of one route compare by order. */
  position: number;
  handler: RouteHandler;
}

/** Whether a `use()` pattern such as `/v1/wallets/*` covers a route path. */
function covers(pattern: string, path: string): boolean {
  if (pattern === "/*" || pattern === "*") return true;
  if (!pattern.endsWith("/*")) return pattern === path;
  const base = pattern.slice(0, -2);
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Every step of every POST, PATCH, PUT and DELETE route owned by a module at
 * `stable`, in mount order, including the `use()` middleware whose pattern
 * covers the route. The Idempotency-Key inventories (HOO-1918) read the
 * markers `idempotent()`, `authorize()`, `replayFromRecord()` and the
 * validators leave on these handlers, and the named `projectContext` step.
 */
export function stableMutatingRouteSteps(): StableMutatingRouteStep[] {
  const app = createApp({
    rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
  });
  const steps: StableMutatingRouteStep[] = [];
  const middleware: { pattern: string; position: number; handler: RouteHandler }[] = [];
  const withMiddleware = new Set<string>();
  let position = 0;
  for (const route of app.routes) {
    position += 1;
    const method = route.method.toUpperCase();
    if (method === "ALL") {
      middleware.push({ pattern: route.path, position, handler: route.handler });
      continue;
    }
    if (!MUTATING_METHODS.has(method)) continue;
    const owner = routeOwnerOf(route.path);
    if (owner === undefined || owner === "core" || !STABLE_MODULES.has(owner)) continue;
    const key = `${method} ${route.path}`;
    if (!withMiddleware.has(key)) {
      withMiddleware.add(key);
      for (const step of middleware) {
        if (covers(step.pattern, route.path)) {
          steps.push({ route: key, position: step.position, handler: step.handler });
        }
      }
    }
    steps.push({ route: key, position, handler: route.handler });
  }
  return steps;
}
