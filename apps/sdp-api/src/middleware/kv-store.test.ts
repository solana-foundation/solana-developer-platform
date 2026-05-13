import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { KVStoreSet } from "@/runtime/kv";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { kvStoreMiddleware } from "./kv-store";

type Vars = { kv?: KVStoreSet };

function buildApp(...skipPaths: string[]) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use("*", kvStoreMiddleware(...skipPaths));
  app.all("*", (c) => c.json({ kvSet: c.var.kv !== undefined }));
  return app;
}

describe("kvStoreMiddleware", () => {
  it("populates c.var.kv on paths not in the skip list", async () => {
    const app = buildApp("/health", "/openapi.json");
    const res = await app.request("/api/foo", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kvSet: true });
  });

  it("skips paths in the skip list (c.var.kv stays unset)", async () => {
    const app = buildApp(
      "/",
      "/health",
      "/health/ready",
      "/openapi.json",
      "/docs",
      "/llms.txt",
      "/webhooks"
    );
    for (const path of [
      "/",
      "/health",
      "/health/ready",
      "/openapi.json",
      "/docs",
      "/llms.txt",
      "/webhooks",
    ]) {
      const res = await app.request(path, {}, env);
      expect(res.status, `path=${path}`).toBe(200);
      expect(await res.json(), `path=${path}`).toEqual({ kvSet: false });
    }
  });

  it("matches segment-prefix paths so /health also skips /health/anything", async () => {
    const app = buildApp("/health", "/webhooks");
    for (const path of ["/health/ready", "/health/deep/nested", "/webhooks/clerk"]) {
      const res = await app.request(path, {}, env);
      expect(res.status, `path=${path}`).toBe(200);
      expect(await res.json(), `path=${path}`).toEqual({ kvSet: false });
    }
  });

  it("does NOT skip look-alike paths that share a name prefix without a / boundary", async () => {
    // Stricter than skipRateLimitPaths on purpose: /healthz must not match /health.
    // Leaving c.var.kv undefined on a real route would surface as a deep NPE in a
    // handler, which is worse than the regression this skip list was added to fix.
    const app = buildApp("/health", "/docs", "/llms.txt");
    for (const path of ["/healthz", "/docsy", "/llms.txt.backup"]) {
      const res = await app.request(path, {}, env);
      expect(res.status, `path=${path}`).toBe(200);
      expect(await res.json(), `path=${path}`).toEqual({ kvSet: true });
    }
  });

  it("ignores query strings (skip decision uses pathname only)", async () => {
    const app = buildApp("/health");
    const res = await app.request("/health?verbose=1", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kvSet: false });
  });

  it("trailing slash on a non-skipped path does not flip the decision", async () => {
    const app = buildApp("/health");
    // `/health/` matches `/health/` startsWith `/health/` → skipped (segment-prefix).
    const res = await app.request("/health/", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kvSet: false });
  });

  it("root `/` only skips exact root, not other paths", async () => {
    const app = buildApp("/");
    const exact = await app.request("/", {}, env);
    expect(await exact.json()).toEqual({ kvSet: false });
    const other = await app.request("/api/foo", {}, env);
    expect(await other.json()).toEqual({ kvSet: true });
  });

  it("with no skip paths, populates c.var.kv on every request (back-compat)", async () => {
    const app = buildApp();
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kvSet: true });
  });
});
