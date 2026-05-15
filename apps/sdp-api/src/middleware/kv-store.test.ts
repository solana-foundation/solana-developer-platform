import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { KVStoreSet } from "@/runtime/kv";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { kvStoreMiddleware } from "./kv-store";
import { skipRateLimitPaths } from "./rate-limit";

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
    // Segment-prefix matching: `/healthz` must not match `/health`. Leaving
    // c.var.kv undefined on a real route would surface as a deep handler NPE.
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

  // When kvStoreMiddleware and skipRateLimitPaths share the same skip list,
  // a KV-free root redirect must flow through both middlewares to its
  // handler. Locks in the contract that an aligned skip list = the handler
  // is reachable without c.var.kv being set.
  it("with aligned skip lists, GET / reaches its handler", async () => {
    const SKIP = ["/", "/health"];
    const app = new Hono<{ Bindings: Env; Variables: Vars }>();
    let handlerCalled = false;
    app.use("*", kvStoreMiddleware(...SKIP));
    app.use("*", skipRateLimitPaths(...SKIP));
    app.get("/", (c) => {
      handlerCalled = true;
      return c.redirect("/health");
    });
    const res = await app.request("/", {}, env);
    expect(handlerCalled).toBe(true);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/health");
  });

  // Bare `startsWith` would mis-skip the whole API when `/` is listed (every
  // pathname starts with `/`). Segment-prefix limits `/` to the exact root.
  // Detect whether rate-limit actually ran via the X-RateLimit-* headers it
  // sets — absence proves it was skipped.
  it("`/` in skipRateLimitPaths skips exact root only — rate-limit still runs on /api/foo", async () => {
    const app = new Hono<{ Bindings: Env; Variables: Vars }>();
    app.use("*", kvStoreMiddleware());
    app.use("*", skipRateLimitPaths("/"));
    app.get("/", (c) => c.json({ where: "root" }));
    app.get("/api/foo", (c) => c.json({ where: "api" }));

    const root = await app.request("/", {}, env);
    expect(root.status).toBe(200);
    expect(root.headers.get("X-RateLimit-Limit")).toBeNull();

    const api = await app.request("/api/foo", {}, env);
    expect(api.status).toBe(200);
    expect(api.headers.get("X-RateLimit-Limit")).not.toBeNull();
  });
});
