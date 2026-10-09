import type { SdpModule } from "@sdp/types";

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
  [/^\/v1\/policies(\/|$)/, "policies"],
  [/^\/v1\/payments\/wallets\/:walletId\/policies(\/|$)/, "policies"],
  [/^\/v1\/api-keys\/:keyId\/policy-(profiles|bindings)(\/|$)/, "policies"],
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
