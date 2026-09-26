import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { requestTracingMiddleware } from "./request-tracing";

// A bearer public_token as the migration describes it: possession is
// authorization, so its presence in a retained log field is the leak.
const BEARER_TOKEN = "TraceLeak9Abc123X";

function buildApp() {
  // Mirrors the production wiring under test: a public payment router whose
  // routes carry the bearer token as a path parameter, mounted on an app with
  // the global tracing middleware (apps/sdp-api/src/app.ts).
  const pay = new Hono<{ Bindings: Env }>();
  pay.get("/:token", (c) => c.json({ ok: true }));
  pay.post("/:token/tx", (c) => c.json({ ok: true }));

  const app = new Hono<{ Bindings: Env }>();
  app.use("*", requestTracingMiddleware());
  app.route("/pay", pay);
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}

type InfoCall = Parameters<ReturnType<typeof getLogger>["info"]>;

function timingEvents(calls: InfoCall[]): Array<Record<string, unknown>> {
  return calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((payload) => payload?.event === "sdp_api_request_timing");
}

describe("requestTracingMiddleware", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the route template, never the bearer payment token, for /pay/:token", async () => {
    const app = buildApp();
    const info = vi.spyOn(getLogger(), "info").mockImplementation(() => {});

    const res = await app.request(`/pay/${BEARER_TOKEN}`);

    expect(res.status).toBe(200);
    const events = timingEvents(info.mock.calls);
    expect(events).toHaveLength(1);
    expect(events[0].path).toBe("/pay/:token");
    expect(JSON.stringify(info.mock.calls)).not.toContain(BEARER_TOKEN);
  });

  it("logs the route template for /pay/:token/tx too", async () => {
    const app = buildApp();
    const info = vi.spyOn(getLogger(), "info").mockImplementation(() => {});

    const res = await app.request(`/pay/${BEARER_TOKEN}/tx`, { method: "POST" });

    expect(res.status).toBe(200);
    const events = timingEvents(info.mock.calls);
    expect(events).toHaveLength(1);
    expect(events[0].path).toBe("/pay/:token/tx");
    expect(JSON.stringify(info.mock.calls)).not.toContain(BEARER_TOKEN);
  });

  it("never logs the raw pathname when no route matched", async () => {
    const app = buildApp();
    const info = vi.spyOn(getLogger(), "info").mockImplementation(() => {});

    const res = await app.request(`/pay/${BEARER_TOKEN}/nope`);
    expect(res.status).toBe(404);

    const events = timingEvents(info.mock.calls);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(info.mock.calls)).not.toContain(BEARER_TOKEN);
    expect(JSON.stringify(info.mock.calls)).not.toContain("/pay/");
  });

  it("labels a middleware-rejected request with the endpoint route template, not *", async () => {
    // Mirrors the production wiring: a global limiter-style middleware
    // rejects after routing but before the handler runs (e.g. a 429), so
    // routeIndex still points at the middleware's `*` entry when the timing
    // log is emitted.
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", requestTracingMiddleware());
    app.use("*", async () => {
      // Rejects before calling next(), like the global rate limiter's 429:
      // the handler never runs, so routeIndex still points at this
      // middleware's `*` entry when the timing log is emitted.
      throw new Error("global limiter rejected the request");
    });
    const pay = new Hono<{ Bindings: Env }>();
    pay.get("/:token", (c) => c.json({ ok: true }));
    app.route("/pay", pay);

    const info = vi.spyOn(getLogger(), "info").mockImplementation(() => {});

    const res = await app.request(`/pay/${BEARER_TOKEN}`);

    expect(res.status).toBe(500);
    const events = timingEvents(info.mock.calls);
    expect(events).toHaveLength(1);
    expect(events[0].path).toBe("/pay/:token");
    expect(JSON.stringify(info.mock.calls)).not.toContain(BEARER_TOKEN);
  });

  it("keeps diagnosis fields intact: method, status, duration, source, event", async () => {
    const app = buildApp();
    const info = vi.spyOn(getLogger(), "info").mockImplementation(() => {});

    await app.request("/health");

    const events = timingEvents(info.mock.calls);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("sdp_api_request_timing");
    expect(events[0].method).toBe("GET");
    expect(events[0].status).toBe(200);
    expect(typeof events[0].duration_ms).toBe("number");
    expect(events[0].source).toBe("unknown");
  });

  it("keeps static routes readable instead of redacting them", async () => {
    const app = buildApp();
    const info = vi.spyOn(getLogger(), "info").mockImplementation(() => {});

    await app.request("/health");

    const events = timingEvents(info.mock.calls);
    expect(events[0].path).toBe("/health");
  });
});
