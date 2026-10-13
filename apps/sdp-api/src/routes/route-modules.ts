import type { SdpModule } from "@sdp/types";

export type RouteOwner = SdpModule | "core";

/**
 * Which module owns each API route, first match wins. `core` routes run in every
 * release channel. A new route must land here before CI passes, and once it is filed
 * under a module, every release channel that leaves that module out must refuse it
 * (route-modules.test.ts). Each deployment's public OpenAPI document publishes only
 * routes whose owner is in its release channel (openapi/spec.ts).
 */
export const ROUTE_OWNERS: readonly (readonly [RegExp, RouteOwner])[] = [
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

/**
 * The module that owns a route, or undefined when none is filed.
 *
 * @param path - A Hono route pattern (`/v1/x/:id`) or an OpenAPI path (`/v1/x/{id}`).
 */
export function routeOwnerOf(path: string): RouteOwner | undefined {
  const pattern = path.replace(/\/\{([A-Za-z0-9_]+)\}/g, "/:$1");
  return ROUTE_OWNERS.find(([owner]) => owner.test(pattern))?.[1];
}
