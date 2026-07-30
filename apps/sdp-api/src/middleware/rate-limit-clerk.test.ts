import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { env } from "@/test/helpers/env";
import { clearKVStores, readRateLimitCount } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

// Signature verification itself is covered elsewhere; what matters here is that a
// verified dashboard caller is counted rather than waved through.
const { verifyClerkJwtForRequest } = vi.hoisted(() => ({
  verifyClerkJwtForRequest: vi.fn(),
}));

vi.mock("@/lib/clerk-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clerk-token")>()),
  verifyClerkJwtForRequest,
}));

const { CLERK_USER_MAX_REQUESTS, skipRateLimitPaths } = await import("@/middleware/rate-limit");

const USER_ID = "user_ratelimit_test";
const ISSUER = "https://clerk.rate-limit-test.example";

// The middleware only reaches verification for a token whose issuer matches
// CLERK_ISSUER, which the shared test env doesn't set.
const clerkEnv = { ...(env as object), CLERK_ISSUER: ISSUER } as unknown as Env;

// Shape only — verification is mocked. `looksLikeClerkJwt` inspects the payload's issuer.
function clerkJwt(): string {
  const part = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part({ sub: USER_ID, iss: ISSUER })}.sig`;
}

const AUTH = { Authorization: `Bearer ${clerkJwt()}` };

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", kvStoreMiddleware());
  app.use("*", skipRateLimitPaths("/health"));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/v1/thing", (c) => c.json({ ok: true }));
  // Mirrors the real app's handler so a thrown AppError surfaces as its status.
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toResponse(), err.statusCode as ContentfulStatusCode)
      : c.json({ error: String(err) }, 500)
  );
  return app;
}

describe("dashboard rate limiting", () => {
  beforeEach(async () => {
    await clearKVStores(env);
    verifyClerkJwtForRequest.mockReset();
    verifyClerkJwtForRequest.mockResolvedValue({ sub: USER_ID });
  });

  it("counts a verified dashboard request against a per-user bucket", async () => {
    const res = await buildApp().request("/v1/thing", { headers: AUTH }, clerkEnv);

    expect(res.status).toBe(200);
    // The bucket is keyed on the user, not the client IP — one office behind a single
    // NAT address is many people, and they must not pool against each other.
    expect(await readRateLimitCount(env, `clerk:${USER_ID}`)).toBe(1);
  });

  it("429s a dashboard caller that blows through the per-user ceiling", async () => {
    // Seed the bucket to the ceiling rather than issuing hundreds of requests.
    const { createKVStoreSet } = await import("@/runtime/kv-redis");
    const kv = createKVStoreSet(env);
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
    await kv.rateLimits.put(
      `ratelimit:clerk:${USER_ID}:${windowStart}`,
      String(CLERK_USER_MAX_REQUESTS)
    );

    const res = await buildApp().request("/v1/thing", { headers: AUTH }, clerkEnv);
    expect(res.status).toBe(429);
  });

  it("leaves exempt paths uncounted", async () => {
    await buildApp().request("/health", { headers: AUTH }, clerkEnv);
    expect(await readRateLimitCount(env, `clerk:${USER_ID}`)).toBe(0);
  });

  it("does not give an unverifiable JWT the per-user bucket", async () => {
    verifyClerkJwtForRequest.mockRejectedValue(new Error("bad signature"));

    await buildApp().request("/v1/thing", { headers: AUTH }, clerkEnv);

    // Falls through to the anonymous per-IP limit, which is what bounds signature spray.
    expect(await readRateLimitCount(env, `clerk:${USER_ID}`)).toBe(0);
  });
});
