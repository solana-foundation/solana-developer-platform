import type { CachedApiKey, CachedSession } from "@sdp/types";
import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";

/**
 * Pure context-var resolution — no DB, no middleware chain. The mini app
 * injects auth vars the way authMiddleware/projectContextMiddleware would,
 * then a probe handler echoes what the resolver settled on. AppErrors are
 * mapped to their HTTP status the same way the real app's error handler does.
 */
function buildApp(setup: (c: Context<{ Bindings: Env }>) => void) {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", async (c, next) => {
    setup(c);
    await next();
  });
  app.get("/probe", (c) => c.json({ environment: resolveSdpEnvironment(c) }));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toResponse(), err.statusCode as 400 | 401 | 500);
    }
    throw err;
  });

  return app;
}

function apiKeyContext(environment: "sandbox" | "production"): CachedApiKey {
  return {
    id: "key_sdp_environment",
    organizationId: "org_sdp_environment",
    projectId: "prj_sdp_environment",
    role: "api_admin",
    permissions: ["*"],
    environment,
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
  };
}

const session = {
  userId: "usr_sdp_environment",
  organizationId: "org_sdp_environment",
} as CachedSession;

async function probe(setup: (c: Context<{ Bindings: Env }>) => void) {
  return buildApp(setup).request("/probe", {}, env);
}

describe("resolveSdpEnvironment", () => {
  it("returns the API key's environment for key callers", async () => {
    for (const environment of ["sandbox", "production"] as const) {
      const res = await probe((c) => c.set("apiKey", apiKeyContext(environment)));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ environment });
    }
  });

  it("returns the membership-verified project environment for session callers", async () => {
    for (const environment of ["sandbox", "production"] as const) {
      const res = await probe((c) => {
        c.set("session", session);
        c.set("projectEnvironment", environment);
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ environment });
    }
  });

  it("prefers the key's environment when both context vars are present", async () => {
    // projectContextMiddleware copies the key's environment, so the two never
    // genuinely differ in a mounted route; this pins the precedence anyway.
    const res = await probe((c) => {
      c.set("apiKey", apiKeyContext("sandbox"));
      c.set("projectEnvironment", "production");
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ environment: "sandbox" });
  });

  it("fails closed instead of defaulting when no environment is resolvable", async () => {
    const res = await probe(() => {});

    // Never sandbox-by-default: that pointed sandbox provider credentials at
    // production-project tenant rows for every dashboard caller (PRO-1641).
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});
