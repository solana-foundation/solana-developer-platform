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
import { ownerOf, ROUTE_OWNERS } from "@/test/helpers/route-owners";

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
