import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { skipRateLimitPaths } from "@/middleware/rate-limit";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
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
    vi.restoreAllMocks();
    await clearTestDatabase(env);
    await clearKVStores(env);
    env.CLERK_ISSUER = undefined;
    env.CLERK_JWKS_URL = undefined;
    env.CLERK_SECRET_KEY = undefined;
    env.CLERK_API_URL = undefined;
  });

  function createProtectedApp(payload: ClerkJwtPayload) {
    const token = createJwt(payload);
    const app = new Hono<{ Bindings: Env }>();

    app.use("*", kvStoreMiddleware());
    app.use("*", async (c, next) => {
      c.set("verifiedClerkJwt", { token, payload });
      await next();
    });
    app.use("*", skipRateLimitPaths());
    app.use("*", unifiedAuthMiddleware({ allowClerk: true }));
    app.get("/protected", requirePermissions("org:read"), (c) => {
      return c.json({
        organizationId: c.get("clerk")?.organizationId ?? null,
      });
    });

    return { app, token };
  }

  it("reuses a cached Clerk JWT across rate limiting and auth in one request", async () => {
    const payload: ClerkJwtPayload = {
      sub: "clerk_user_cached",
      org_id: "clerk_org_cached",
      org_role: "org:admin",
      org_slug: TEST_ORG.slug,
      email: "clerk-cache@example.com",
      iss: "https://clerk.example.test",
    };
    env.CLERK_ISSUER = payload.iss;
    env.CLERK_JWKS_URL = undefined;
    const { app, token } = createProtectedApp(payload);

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

    const projects = await getDb(env)
      .prepare("SELECT slug FROM projects WHERE organization_id = ? ORDER BY slug")
      .bind(TEST_ORG.id)
      .all<{ slug: string }>();
    expect(projects.results.map((project) => project.slug)).toEqual([
      "default-production",
      "default-sandbox",
    ]);
  });

  it("provisions default projects when the membership webhook has not arrived", async () => {
    await getDb(env)
      .prepare("DELETE FROM organization_members WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .run();

    const payload: ClerkJwtPayload = {
      sub: "clerk_user_cached",
      org_id: "clerk_org_cached",
      org_role: "org:admin",
      org_slug: TEST_ORG.slug,
      email: "clerk-cache@example.com",
      iss: "https://clerk.example.test",
    };
    const { app, token } = createProtectedApp(payload);

    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(200);

    const projects = await getDb(env)
      .prepare("SELECT slug FROM projects WHERE organization_id = ? ORDER BY slug")
      .bind(TEST_ORG.id)
      .all<{ slug: string }>();
    expect(projects.results.map((project) => project.slug)).toEqual([
      "default-production",
      "default-sandbox",
    ]);
  });

  it("bootstraps an unlinked Clerk organization on the first authenticated request", async () => {
    const originalFetch = globalThis.fetch;
    env.CLERK_SECRET_KEY = "sk_test_clerk_auth_bootstrap";
    env.CLERK_API_URL = "https://clerk.example.test/v1";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${env.CLERK_API_URL}/organizations/clerk_org_new`) {
        return new Response(
          JSON.stringify({
            id: "clerk_org_new",
            name: "New Clerk Organization",
            slug: "new-clerk-organization",
            private_metadata: {
              sdp: {
                tier: "enterprise",
                providerOverrides: { ramps: { coinbase: false } },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return originalFetch(input, init);
    });

    const payload: ClerkJwtPayload = {
      sub: "clerk_user_cached",
      org_id: "clerk_org_new",
      org_role: "org:admin",
      org_slug: "new-clerk-organization",
      email: "clerk-cache@example.com",
      iss: "https://clerk.example.test",
    };
    const { app, token } = createProtectedApp(payload);

    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizationId: string };
    expect(body.organizationId).toMatch(/^org_/);

    const mapping = await getDb(env)
      .prepare(
        `SELECT organization_id
         FROM auth_organization_identities
         WHERE provider = 'clerk' AND provider_org_id = ?`
      )
      .bind("clerk_org_new")
      .first<{ organization_id: string }>();
    expect(mapping?.organization_id).toBe(body.organizationId);

    const organization = await getDb(env)
      .prepare("SELECT tier, settings FROM organizations WHERE id = ?")
      .bind(body.organizationId)
      .first<{ tier: string; settings: string | null }>();
    expect(organization?.tier).toBe("enterprise");
    expect(JSON.parse(organization?.settings ?? "{}")).toEqual({
      providerOverrides: { ramps: { coinbase: false } },
    });

    const projects = await getDb(env)
      .prepare("SELECT slug FROM projects WHERE organization_id = ? ORDER BY slug")
      .bind(body.organizationId)
      .all<{ slug: string }>();
    expect(projects.results.map((project) => project.slug)).toEqual([
      "default-production",
      "default-sandbox",
    ]);
  });
});
