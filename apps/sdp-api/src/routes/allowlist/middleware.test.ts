import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import { adminAuth } from "./middleware";

const ADMIN_KEY = "platform-admin-secret";
const ADMIN_ORG_ID = "org_platform_admin";

function buildApp(setup?: (c: Context<{ Bindings: Env }>) => void) {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", async (c, next) => {
    setup?.(c);
    await next();
  });
  app.use("*", adminAuth);
  app.get("/probe", (c) => c.json({ ok: true }));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toResponse(), err.statusCode as 401 | 403);
    }
    throw err;
  });

  return app;
}

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    ENVIRONMENT: "development",
    ALLOWLIST_ADMIN_KEY: ADMIN_KEY,
    ALLOWLIST_ADMIN_ORG_ID: ADMIN_ORG_ID,
    ...overrides,
  };
}

describe("allowlist adminAuth", () => {
  it("rejects a customer wildcard API key", async () => {
    const app = buildApp((c) => {
      c.set("apiKey", {
        id: "key_customer",
        organizationId: "org_customer",
        projectId: "prj_customer",
        role: "api_admin",
        permissions: ["*"],
        environment: "production",
        signingWalletId: null,
      });
    });

    const res = await app.request("/probe", {}, testEnv());
    expect(res.status).toBe(403);
  });

  it("rejects requests without a platform credential, even in development", async () => {
    const res = await buildApp().request("/probe", {}, testEnv());
    expect(res.status).toBe(403);
  });

  it("allows a matching X-Admin-Key", async () => {
    const res = await buildApp().request(
      "/probe",
      { headers: { "X-Admin-Key": ADMIN_KEY } },
      testEnv()
    );
    expect(res.status).toBe(200);
  });

  it("rejects a mismatched X-Admin-Key", async () => {
    const res = await buildApp().request(
      "/probe",
      { headers: { "X-Admin-Key": "wrong-key" } },
      testEnv()
    );
    expect(res.status).toBe(403);
  });

  it("allows a Clerk admin in the designated admin org", async () => {
    const app = buildApp((c) => {
      c.set("clerk", {
        userId: "usr_admin",
        organizationId: ADMIN_ORG_ID,
        permissions: ["org:admin"],
        role: "admin",
        clerkUserId: "clerk_usr",
        clerkOrgId: "clerk_org",
        email: "admin@platform.test",
        orgSlug: null,
        orgRole: "admin",
      });
    });

    const res = await app.request("/probe", {}, testEnv());
    expect(res.status).toBe(200);
  });

  it("rejects a Clerk admin from a different organization", async () => {
    const app = buildApp((c) => {
      c.set("clerk", {
        userId: "usr_admin",
        organizationId: "org_other",
        permissions: ["org:admin"],
        role: "admin",
        clerkUserId: "clerk_usr",
        clerkOrgId: "clerk_org",
        email: "admin@other.test",
        orgSlug: null,
        orgRole: "admin",
      });
    });

    const res = await app.request("/probe", {}, testEnv());
    expect(res.status).toBe(403);
  });
});
