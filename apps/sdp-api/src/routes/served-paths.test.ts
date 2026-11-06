import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";
import { Hono } from "hono";
import { inspectRoutes } from "hono/dev";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import { servedPaths } from "@/routes/served-paths";
import servedPathsJson from "@/routes/served-paths.generated.json";
import type { Env } from "@/types/env";

const app = createApp({
  rampProviderMaturity: SDP_RAMP_PROVIDER_MATURITY,
});

function syntheticApp(routePaths: string[]): Hono<{ Bindings: Env }> {
  const synthetic = new Hono<{ Bindings: Env }>();
  synthetic.use("/v1/*", async (_c, next) => {
    await next();
  });
  for (const routePath of routePaths) {
    synthetic.get(routePath, (c) => c.text("ok"));
  }
  return synthetic;
}

function isAdmitted(routePath: string): boolean {
  return Object.entries(servedPathsJson).some(([entry, match]) =>
    match === "exact"
      ? routePath === entry
      : routePath === entry || routePath.startsWith(`${entry}/`)
  );
}

describe("servedPaths", () => {
  it("matches the generated served path list (pnpm -C apps/sdp-api served-paths:generate)", () => {
    expect(servedPathsJson).toEqual(servedPaths(app));
  });

  it("admits every route the app serves", () => {
    const unadmitted = inspectRoutes(app)
      .filter((route) => !route.isMiddleware && !isAdmitted(route.path))
      .map((route) => `${route.method} ${route.path}`);
    expect(unadmitted).toEqual([]);
  });

  it("lists the root, namespaces and top-level files exactly and every other route by its family, sorted, skipping middleware", () => {
    const synthetic = syntheticApp([
      "/v1/payments/widgets/:id",
      "/v1/gadgets/:id/meta.json",
      "/status/live",
      "/robots.txt",
      "/v1",
      "/",
    ]);
    expect(Object.entries(servedPaths(synthetic))).toEqual([
      ["/", "exact"],
      ["/robots.txt", "exact"],
      ["/status", "prefix"],
      ["/v1", "exact"],
      ["/v1/gadgets", "prefix"],
      ["/v1/payments/widgets", "prefix"],
    ]);
  });

  it.each(["/v1/:id", "/v1/payments/*"])(
    "throws for %s, whose family segment is not literal",
    (routePath) => {
      expect(() => servedPaths(syntheticApp([routePath]))).toThrow(routePath);
    }
  );
});
