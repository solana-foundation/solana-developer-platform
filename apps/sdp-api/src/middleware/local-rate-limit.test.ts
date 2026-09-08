import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { localRateLimit } from "./local-rate-limit";

// SAFETY: the limiter reads only K_SERVICE, via getClientIp; the rest of Env is
// irrelevant to it and constructing a whole one would say nothing extra.
const CLOUD_RUN_ENV = { K_SERVICE: "sdp-api" } as unknown as Env;

function buildApp(limits: { maxRequests: number; maxTrackedKeys: number }) {
  const app = new Hono<{ Bindings: Env }>();
  app.use(
    "*",
    localRateLimit({
      name: "test",
      maxRequests: limits.maxRequests,
      windowMs: 60_000,
      maxTrackedKeys: limits.maxTrackedKeys,
    })
  );
  app.onError((error) => new Response(error.message, { status: 429 }));
  app.get("/", (c) => c.text("ok"));
  return app;
}

/** A verified client address as the Google load balancer presents it. */
function fromAddress(address: string) {
  return { headers: { "x-forwarded-for": `${address}, 130.211.0.1` } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("localRateLimit", () => {
  it("admits up to the limit and refuses the next request from that address", async () => {
    const app = buildApp({ maxRequests: 3, maxTrackedKeys: 8 });
    const request = () => app.request("/", fromAddress("203.0.113.7"), CLOUD_RUN_ENV);

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
  });

  it("counts each address separately", async () => {
    const app = buildApp({ maxRequests: 1, maxTrackedKeys: 8 });

    expect((await app.request("/", fromAddress("203.0.113.7"), CLOUD_RUN_ENV)).status).toBe(200);
    expect((await app.request("/", fromAddress("203.0.113.8"), CLOUD_RUN_ENV)).status).toBe(200);
    expect((await app.request("/", fromAddress("203.0.113.7"), CLOUD_RUN_ENV)).status).toBe(429);
  });

  it("admits the refused caller again in the next window", async () => {
    const app = buildApp({ maxRequests: 1, maxTrackedKeys: 8 });
    const request = () => app.request("/", fromAddress("203.0.113.7"), CLOUD_RUN_ENV);

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);

    vi.advanceTimersByTime(60_000);
    expect((await request()).status).toBe(200);
  });

  it("holds a spray of distinct addresses to one shared bucket", async () => {
    // The point of the cap: the limiter must not become the memory exhaustion
    // it was added to prevent, so everything past it is counted together.
    const app = buildApp({ maxRequests: 2, maxTrackedKeys: 2 });

    expect((await app.request("/", fromAddress("198.51.100.1"), CLOUD_RUN_ENV)).status).toBe(200);
    expect((await app.request("/", fromAddress("198.51.100.2"), CLOUD_RUN_ENV)).status).toBe(200);

    const sprayed = [];
    for (let index = 3; index < 9; index += 1) {
      sprayed.push(
        (await app.request("/", fromAddress(`198.51.100.${index}`), CLOUD_RUN_ENV)).status
      );
    }

    expect(sprayed).toEqual([200, 200, 429, 429, 429, 429]);
  });

  it("counts a caller the proxy did not verify against the shared bucket", async () => {
    // A single caller-supplied X-Forwarded-For is not a verified address on
    // Cloud Run, so it must not buy its own allowance by inventing one.
    const app = buildApp({ maxRequests: 1, maxTrackedKeys: 8 });
    const spoofed = { headers: { "x-forwarded-for": "203.0.113.99" } };

    expect((await app.request("/", spoofed, CLOUD_RUN_ENV)).status).toBe(200);
    expect((await app.request("/", { headers: {} }, CLOUD_RUN_ENV)).status).toBe(429);
  });
});
