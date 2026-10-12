import { SDP_RAMP_PROVIDER_STAGES, SDP_RELEASE_CHANNELS, type SdpModule } from "@sdp/types";
import { createApp } from "@/app";
import { noopObservability } from "@/runtime/observability";

/**
 * Which module owns each API route, first match wins. `core` routes run in every
 * release channel. A new route must land here before CI passes, and once it is filed
 * under a module, every release channel that leaves that module out must refuse it.
 * `routes/route-modules.test.ts` snapshots every route with its owner, so a route
 * that a broad prefix files silently still shows up in review.
 */
export const ROUTE_OWNERS: readonly (readonly [RegExp, SdpModule | "core"])[] = [
  [/^\/v1\/payments\/ramps(\/|$)/, "ramps"],
  [/^\/webhooks\/payments\/ramps\//, "ramps"],
  [/^\/v1\/counterparties\/:counterpartyId\/(requirements|provider-accounts)(\/|$)/, "ramps"],
  [/^\/v1\/issuance(\/|$)/, "issuance"],
  [/^\/v1\/earn(\/|$)/, "earn"],
  [/^\/v1\/dvp(\/|$)/, "dvp"],
  [/^\/v1\/private-channels(\/|$)/, "private_channels"],
  [/^\/(v1|internal\/dashboard)\/helius-rings(\/|$)/, "helius_rings"],
  [
    /^\/v1\/payments\/(recurring-payments|subscription-plans|subscriptions)(\/|$)/,
    "recurring_payments",
  ],
  [/^\/(v1\/payments|v1\/counterparties|v1\/transactions|pay)(\/|$)/, "payments"],
  [/^\/(v1\/wallets|internal\/dashboard\/custody)(\/|$)/, "custody"],
  [/^\/v1\/compliance(\/|$)/, "compliance"],
  [
    /^\/(health|docs|openapi\.json|llms\.txt|admin|webhooks\/clerk|internal\/playground)(\/|$)/,
    "core",
  ],
  [/^\/v1\/(members|organizations|projects|onboarding|places|rpc|api-keys)(\/|$)/, "core"],
  [/^\/$/, "core"],
];

export function ownerOf(path: string): SdpModule | "core" | undefined {
  return ROUTE_OWNERS.find(([pattern]) => pattern.test(path))?.[1];
}

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
    const owner = ownerOf(route.path);
    if (owner === undefined || owner === "core" || !STABLE_MODULES.has(owner)) continue;
    steps.push({ route: `${method} ${route.path}`, position, handler: route.handler });
  }
  return steps;
}
