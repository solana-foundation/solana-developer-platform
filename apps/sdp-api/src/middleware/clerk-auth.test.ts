import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { rateLimitMiddleware } from "@/middleware/rate-limit";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVNamespaces } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

const TEST_ORG = {
  id: "org_clerk_cache_request_test",
  name: "Clerk Cache Request Test Org",
  slug: "clerk-cache-request-test-org",
  tier: "individual" as const,
  status: "active" as const,
};

function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createJwt(payload: ClerkJwtPayload): string {
  return `${encodeJwtPart({ alg: "RS256", typ: "JWT" })}.${encodeJwtPart(payload)}.signature`;
}

describe("Clerk auth request cache", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);

    await getDb(env).batch([
      getDb(env).prepare(
        `CREATE TABLE IF NOT EXISTS auth_user_identities (
           id TEXT PRIMARY KEY,
           provider TEXT NOT NULL,
           provider_user_id TEXT NOT NULL,
           user_id TEXT NOT NULL,
           email TEXT
         )`
      ),
      getDb(env).prepare(
        `CREATE TABLE IF NOT EXISTS auth_organization_identities (
           id TEXT PRIMARY KEY,
           provider TEXT NOT NULL,
           provider_org_id TEXT NOT NULL,
           organization_id TEXT NOT NULL,
           slug TEXT
         )`
      ),
    ]);

    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind("usr_clerk_cached", "clerk-cache@example.com"),
      getDb(env)
        .prepare(
          `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
         VALUES (?, 'clerk', ?, ?, ?)`
        )
        .bind(
          "aui_clerk_cached",
          "clerk_user_cached",
          "usr_clerk_cached",
          "clerk-cache@example.com"
        ),
      getDb(env)
        .prepare(
          `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
         VALUES (?, 'clerk', ?, ?, ?)`
        )
        .bind("aoi_clerk_cached", "clerk_org_cached", TEST_ORG.id, TEST_ORG.slug),
      getDb(env)
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'admin', 'active')`
        )
        .bind("mem_clerk_cached", TEST_ORG.id, "usr_clerk_cached"),
    ]);
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
    env.CLERK_ISSUER = undefined;
    env.CLERK_JWKS_URL = undefined;
  });

  it("reuses a cached Clerk JWT across rate limiting and auth in one request", async () => {
    const payload: ClerkJwtPayload = {
      sub: "clerk_user_cached",
      org_id: "clerk_org_cached",
      org_role: "org:admin",
      org_slug: TEST_ORG.slug,
      email: "clerk-cache@example.com",
      iss: "https://clerk.example.test",
    };
    const token = createJwt(payload);

    env.CLERK_ISSUER = payload.iss;
    env.CLERK_JWKS_URL = undefined;

    const app = new Hono<{ Bindings: Env }>();

    app.use("*", kvStoreMiddleware());
    app.use("*", async (c, next) => {
      c.set("verifiedClerkJwt", { token, payload });
      await next();
    });
    app.use("*", rateLimitMiddleware());
    app.use("*", unifiedAuthMiddleware({ allowClerk: true }));

    app.get("/protected", requirePermissions("org:read"), (c) => {
      return c.json({
        organizationId: c.get("clerk")?.organizationId ?? null,
      });
    });

    const res = await app.request(
      "/protected",
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      organizationId: TEST_ORG.id,
    });
  });
});
