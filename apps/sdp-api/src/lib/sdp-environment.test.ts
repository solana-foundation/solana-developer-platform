import type { CachedApiKey, CachedSession } from "@sdp/types";
import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { resolveAnonymousSdpEnvironment, resolveSdpEnvironment } from "@/lib/sdp-environment";
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

async function probe(setup: (c: Context<{ Bindings: Env }>) => void, requestEnv: Env = env) {
  return buildApp(setup).request("/probe", {}, requestEnv);
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

  it("maps the deployment runtime to an anonymous product environment", async () => {
    const sandbox = await probe(() => {}, { ...env, ENVIRONMENT: "development" });
    const production = await probe(() => {}, { ...env, ENVIRONMENT: "production" });

    expect(await sandbox.json()).toEqual({ environment: "sandbox" });
    expect(await production.json()).toEqual({ environment: "production" });
  });

  it("honors an explicit anonymous product environment", async () => {
    const res = await probe(() => {}, {
      ...env,
      ENVIRONMENT: "development",
      SDP_ENVIRONMENT: "production",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ environment: "production" });
  });

  it("fails closed when the deployment environment is invalid", async () => {
    const res = await probe(() => {}, {
      ...env,
      ENVIRONMENT: undefined,
      SDP_ENVIRONMENT: "preview",
    } as unknown as Env);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("resolveAnonymousSdpEnvironment", () => {
  it("uses the exact environment resolution that runs at process startup", () => {
    expect(
      resolveAnonymousSdpEnvironment({ ENVIRONMENT: "development", SDP_ENVIRONMENT: "production" })
    ).toBe("production");
    expect(resolveAnonymousSdpEnvironment({ ENVIRONMENT: "development" })).toBe("sandbox");
    expect(resolveAnonymousSdpEnvironment({ ENVIRONMENT: "production" })).toBe("production");
  });

  it("fails startup validation for an invalid explicit value", () => {
    expect(() =>
      resolveAnonymousSdpEnvironment({
        ENVIRONMENT: "development",
        SDP_ENVIRONMENT: "preview",
      } as unknown as Pick<Env, "SDP_ENVIRONMENT" | "ENVIRONMENT">)
    ).toThrow("SDP_ENVIRONMENT must be sandbox or production");
  });
});
