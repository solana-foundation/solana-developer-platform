import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type Context, Hono, type Next } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { clerkAuthMiddleware, optionalClerkAuth } from "@/middleware/clerk-auth";
import { clerkOnboardingMiddleware } from "@/middleware/clerk-onboarding";
import { getLogger } from "@/runtime/logger";
import { ensureTestClerkIssuer, signTestClerkClaims } from "@/test/helpers/clerk";
import { env as testEnv } from "@/test/helpers/env";
import type { Env } from "@/types/env";

type Middleware = (c: Context<{ Bindings: Env }>, next: Next) => Promise<void>;

function appWith(middleware: Middleware): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", middleware);
  app.get("/resource", (c) => c.json({ authenticated: Boolean(c.get("clerk")) }));
  app.onError((error, c) => {
    if (!(error instanceof AppError)) {
      throw error;
    }
    switch (error.statusCode) {
      case 401:
        return c.json(error.toResponse(), 401);
      case 503:
        return c.json(error.toResponse(), 503);
      default:
        throw error;
    }
  });
  return app;
}

async function refusedJwksUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${address.port}/.well-known/jwks.json`;
}

describe("Clerk auth when the signing keys cannot be fetched", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function unreachableKeys(): Promise<{ env: Env; token: string }> {
    const { issuer } = await ensureTestClerkIssuer({ ...testEnv });
    const token = await signTestClerkClaims(
      { sub: "user_keys_down", v: 2, o: { id: "org_keys_down", rol: "admin", slg: "keys-down" } },
      300
    );
    return {
      env: { ...testEnv, CLERK_ISSUER: issuer, CLERK_JWKS_URL: await refusedJwksUrl() },
      token,
    };
  }

  it.each<[string, () => Middleware]>([
    ["dashboard auth", () => clerkAuthMiddleware()],
    ["strict optional auth", () => optionalClerkAuth({ rejectInvalid: true })],
    ["lenient optional auth", () => optionalClerkAuth({ rejectInvalid: false })],
    ["onboarding auth", () => clerkOnboardingMiddleware()],
  ])("%s answers a retryable 503 instead of rejecting the token", async (_label, middleware) => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
    const { env, token } = await unreachableKeys();

    const res = await appWith(middleware()).request(
      "/resource",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(await res.json()).toEqual({
      error: { code: "SERVICE_UNAVAILABLE", message: "Authentication is temporarily unavailable" },
    });
    expect(warn).toHaveBeenCalledWith(
      {
        event: "sdp_api_clerk_signing_keys_unavailable",
        error_chain: [
          { name: "TypeError", code: null },
          { name: "Error", code: "ECONNREFUSED" },
        ],
      },
      "Clerk signing keys unavailable"
    );
  });

  it("still rejects a token the reachable key set cannot verify", async () => {
    const { issuer, jwksUrl } = await ensureTestClerkIssuer({ ...testEnv });
    const token = await signTestClerkClaims({ sub: "user_expired" }, -60);

    const res = await appWith(clerkAuthMiddleware()).request(
      "/resource",
      { headers: { Authorization: `Bearer ${token}` } },
      { ...testEnv, CLERK_ISSUER: issuer, CLERK_JWKS_URL: jwksUrl }
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "UNAUTHORIZED", message: "Invalid Clerk token" },
    });
  });

  it("lets lenient optional auth continue anonymously only for a token that fails verification", async () => {
    const { issuer, jwksUrl } = await ensureTestClerkIssuer({ ...testEnv });

    const res = await appWith(optionalClerkAuth({ rejectInvalid: false })).request(
      "/resource",
      { headers: { Authorization: "Bearer not-a-jwt" } },
      { ...testEnv, CLERK_ISSUER: issuer, CLERK_JWKS_URL: jwksUrl }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });
});
