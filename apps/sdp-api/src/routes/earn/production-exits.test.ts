import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";
import { inspectRoutes } from "hono/dev";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { isEarnExitOrRead, isEarnRecoveryRoute } from "./exits";

/**
 * Every Earn route that changes state and is NOT an exit. A production
 * organization without the production entitlement is refused these (APE-351),
 * while reads and exits stay open (ADR 0002). Filing a new route here, or
 * among the exits in `index.ts`, is a deliberate choice this test forces.
 */
const EARN_ENTRY_ROUTES = [
  "POST /v1/earn/vault-deposit-previews",
  "POST /v1/earn/external-wallet/deposit-transactions",
  "POST /v1/earn/vault-deposits",
  "POST /v1/earn/external-wallet/deposits",
  "POST /v1/earn/programs",
  "PUT /v1/earn/programs/:programId",
];

function earnRoutes(): Array<{ method: string; path: string }> {
  const app = createApp({
    rampProviderMaturity: SDP_RAMP_PROVIDER_MATURITY,
  });
  const routes = new Map<string, { method: string; path: string }>();
  for (const { method, path, isMiddleware } of inspectRoutes(app)) {
    if (!isMiddleware && path.startsWith("/v1/earn/")) {
      routes.set(`${method} ${path}`, { method, path });
    }
  }
  return [...routes.values()];
}

/** A concrete path for a route pattern, so the classifier sees what a request sees. */
function samplePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z]+/g, "sample_id");
}

describe("Earn exits without the production entitlement (APE-351, ADR 0002)", () => {
  const routes = earnRoutes();

  it("files every state-changing Earn route as an exit or an entry", () => {
    const unfiled = routes
      .filter(({ method }) => method !== "GET" && method !== "HEAD")
      .map(({ method, path }) => `${method} ${path}`)
      .filter(
        (route) =>
          !EARN_ENTRY_ROUTES.includes(route) &&
          !isEarnExitOrRead(
            route.split(" ")[0] as string,
            samplePath(route.split(" ")[1] as string)
          )
      );
    expect(unfiled).toEqual([]);
  });

  it("never treats an entry route as an exit", () => {
    for (const route of EARN_ENTRY_ROUTES) {
      const [method, path] = route.split(" ") as [string, string];
      expect(
        routes.some((r) => r.method === method && r.path === path),
        `${route} is registered`
      ).toBe(true);
      expect(isEarnExitOrRead(method, samplePath(path)), route).toBe(false);
    }
  });

  it("keeps every Earn read open", () => {
    for (const { method, path } of routes.filter((r) => r.method === "GET")) {
      expect(isEarnExitOrRead(method, samplePath(path)), path).toBe(true);
    }
  });

  it("keeps every existing-position read available with Earn disabled", () => {
    for (const { method, path } of routes.filter((r) => r.method === "GET")) {
      expect(isEarnRecoveryRoute(method, samplePath(path)), path).toBe(
        !path.startsWith("/v1/earn/strategies")
      );
    }
    expect(isEarnRecoveryRoute("GET", "/v1/earn/new-feature")).toBe(false);
    expect(isEarnRecoveryRoute("GET", "/v1/payments/movements")).toBe(false);
  });

  it.each([
    "/v1/earn/external-wallet/withdrawal-request-cancel-transactions",
    "/v1/earn/external-wallet/withdrawal-request-cancellations",
    "/v1/earn/vault-withdrawal-requests/request-id/cancel",
  ])("keeps cancellation available as an exit: %s", (path) => {
    expect(isEarnExitOrRead("POST", path)).toBe(true);
    expect(isEarnRecoveryRoute("POST", path)).toBe(true);
  });

  it("refuses unknown methods and paths outside Earn", () => {
    expect(isEarnExitOrRead("DELETE", "/v1/earn/vault-withdrawals")).toBe(false);
    expect(isEarnExitOrRead("POST", "/v1/payments/transfers")).toBe(false);
    expect(isEarnExitOrRead("POST", "/v1/earn/vault-withdrawals/extra")).toBe(false);
  });
});
