import {
  SDP_MODULES,
  SDP_RAMP_PROVIDER_STAGES,
  SDP_RELEASE_CHANNEL_NAMES,
  SDP_RELEASE_CHANNELS,
  type SdpModule,
} from "@sdp/types";
import { inspectRoutes } from "hono/dev";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { noopObservability } from "@/runtime/observability";
import { env as baseEnv } from "@/test/helpers/env";

/**
 * Which module owns each API route, first match wins. `core` routes run in every
 * release channel. A new route must land here before CI passes, and once it is filed
 * under a module, every release channel that leaves that module out must refuse it.
 * The snapshot below lists every route with its owner, so a route that a broad
 * prefix files silently still shows up in review.
 */
const ROUTE_OWNERS: readonly (readonly [RegExp, SdpModule | "core"])[] = [
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

function ownerOf(path: string): SdpModule | "core" | undefined {
  return ROUTE_OWNERS.find(([pattern]) => pattern.test(path))?.[1];
}

function registeredRoutes() {
  const app = createApp({
    observability: noopObservability,
    rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
  });
  const routes = new Map<string, { method: string; path: string }>();
  for (const { method, path, isMiddleware } of inspectRoutes(app)) {
    // `.all()` endpoints count; `.use()` middleware (auth, gates, limits) does not.
    if (!isMiddleware) routes.set(`${method} ${path}`, { method, path });
  }
  return { app, routes: [...routes.values()] };
}

/** `ALL` endpoints answer any method; GET stands in for them. */
function probeMethod(method: string): string {
  return method === "ALL" ? "GET" : method;
}

/** A concrete URL for a route pattern: every param and wildcard gets a placeholder. */
function concretePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, "x1").replace(/\*/g, "x1");
}

describe("API route ownership", () => {
  const { app, routes } = registeredRoutes();

  it("files every registered route under a module or core", () => {
    const unowned = routes.filter(({ path }) => ownerOf(path) === undefined);
    expect(unowned.map(({ method, path }) => `${method} ${path}`)).toEqual([]);
  });

  it("lists every route with its owner", () => {
    const owners = routes.map(({ method, path }) => `${ownerOf(path)} ${method} ${path}`).sort();
    expect(owners).toMatchSnapshot();
  });

  it("files every route pattern against a route that exists", () => {
    const unused = ROUTE_OWNERS.filter(
      ([pattern]) => !routes.some(({ path }) => pattern.test(path))
    );
    expect(unused.map(([pattern]) => String(pattern))).toEqual([]);
  });

  for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
    const excluded = SDP_MODULES.filter(
      (module) => !SDP_RELEASE_CHANNELS[releaseChannel].includes(module)
    );
    const cut = routes.filter(({ path }) => {
      const owner = ownerOf(path);
      return owner !== undefined && owner !== "core" && excluded.includes(owner);
    });
    if (cut.length === 0) continue;

    it(`${releaseChannel}: refuses every route of a module it leaves out`, async () => {
      let client = 0;
      const env = {
        ...baseEnv,
        SDP_RELEASE_CHANNEL: releaseChannel,
        TRUST_PROXY_HEADERS: "true",
        MARKETS_ENABLED: "true",
        EARN_ENABLED: "true",
        PRIVATE_CHANNELS_ENABLED: "true",
        HELIUS_RINGS_ENABLED: "true",
      };
      const served: string[] = [];
      for (const { method, path } of cut) {
        client += 1;
        const response = await app.request(
          concretePath(path),
          // A distinct client per request, so the anonymous rate limit never answers instead.
          {
            method: probeMethod(method),
            headers: { "x-forwarded-for": `10.1.${client >> 8}.${client & 255}` },
          },
          env
        );
        // A refusal, not another 403-shaped failure on the way (e.g. a handler error).
        const refused =
          response.status === 403 && (await response.json()).error?.code === "FORBIDDEN";
        if (!refused) served.push(`${method} ${path} -> ${response.status}`);
      }
      expect(served).toEqual([]);
    });
  }
});
