import { SDP_RAMP_PROVIDER_STAGES, SDP_RELEASE_CHANNELS, type SdpModule } from "@sdp/types";
import { createApp } from "@/app";
import { routeOwnerOf } from "@/routes/route-modules";
import { noopObservability } from "@/runtime/observability";

const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const STABLE_MODULES: ReadonlySet<SdpModule> = new Set(SDP_RELEASE_CHANNELS.stable);

/** One step (middleware or handler) in a stable module's mutating route chain. */
export interface StableMutatingRouteStep {
  /** `METHOD /path`, the key the route inventories pin. */
  route: string;
  /** The step's position across the whole app, so steps of one route compare by order. */
  position: number;
  handler: unknown;
}

/**
 * Every step of every POST, PATCH, PUT and DELETE route owned by a module at
 * `stable`, in mount order. The Idempotency-Key inventories (HOO-1918) read
 * the markers `idempotent()` and `authorize()` leave on these handlers.
 */
export function stableMutatingRouteSteps(): StableMutatingRouteStep[] {
  const app = createApp({
    observability: noopObservability,
    rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
  });
  const steps: StableMutatingRouteStep[] = [];
  let position = 0;
  for (const route of app.routes) {
    position += 1;
    const method = route.method.toUpperCase();
    if (!MUTATING_METHODS.has(method)) continue;
    const owner = routeOwnerOf(route.path);
    if (owner === undefined || owner === "core" || !STABLE_MODULES.has(owner)) continue;
    steps.push({ route: `${method} ${route.path}`, position, handler: route.handler });
  }
  return steps;
}
