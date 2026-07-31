import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
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
        email: c.get("clerk")?.email ?? null,
      });
    });
    app.onError((error, c) => {
      if (error instanceof AppError) {
        return c.json(error.toResponse(), error.statusCode as 401 | 403);
      }
      throw error;
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
      email: "clerk-cache@example.com",
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

  it("rejects a stale Clerk JWT after the local organization membership is removed", async () => {
    await getDb(env)
      .prepare(
        "UPDATE organization_members SET status = 'removed' WHERE organization_id = ? AND user_id = ?"
      )
      .bind(TEST_ORG.id, "usr_clerk_cached")
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

    expect(res.status).toBe(401);
    const membership = await getDb(env)
      .prepare("SELECT status FROM organization_members WHERE organization_id = ? AND user_id = ?")
      .bind(TEST_ORG.id, "usr_clerk_cached")
      .first<{ status: string }>();
    expect(membership?.status).toBe("removed");
  });

  it("does not link a first-time Clerk identity until its primary email is verified", async () => {
    await getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind("usr_email_collision_target", "collision-target@example.com")
      .run();

    env.CLERK_SECRET_KEY = "sk_test_clerk_auth_user_lookup";
    env.CLERK_API_URL = "https://clerk.example.test/v1";
    let verificationStatus = "unverified";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(url).toBe(`${env.CLERK_API_URL}/users/clerk_user_first_login`);
      return new Response(
        JSON.stringify({
          id: "clerk_user_first_login",
          primary_email_address_id: "email_primary",
          email_addresses: [
            {
              id: "email_primary",
              email_address: "collision-target@example.com",
              verification: { status: verificationStatus },
            },
            {
              id: "email_secondary",
              email_address: "verified-secondary@example.com",
              verification: { status: "verified" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const payload: ClerkJwtPayload = {
      sub: "clerk_user_first_login",
      org_id: "clerk_org_cached",
      org_role: "org:member",
      org_slug: TEST_ORG.slug,
      email: "collision-target@example.com",
      iss: "https://clerk.example.test",
    };
    const { app, token } = createProtectedApp(payload);

    const unverified = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(unverified.status).toBe(401);

    const missingIdentity = await getDb(env)
      .prepare(
        `SELECT user_id
         FROM auth_user_identities
         WHERE provider = 'clerk' AND provider_user_id = ?`
      )
      .bind("clerk_user_first_login")
      .first<{ user_id: string }>();
    expect(missingIdentity).toBeNull();

    verificationStatus = "verified";
    const verified = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(verified.status).toBe(200);

    const linkedIdentity = await getDb(env)
      .prepare(
        `SELECT user_id
         FROM auth_user_identities
         WHERE provider = 'clerk' AND provider_user_id = ?`
      )
      .bind("clerk_user_first_login")
      .first<{ user_id: string }>();
    expect(linkedIdentity?.user_id).toBe("usr_email_collision_target");
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

  /**
   * Clerk's acceptance link outlives a local revocation, so signing in through
   * it is the other way a withdrawn invitation could still be redeemed.
   */
  async function seedInvitation(status: string, createdAt: string, expiresInDays = 7) {
    await getDb(env)
      .prepare(
        `INSERT INTO invitations
           (id, organization_id, email, role, invited_by, token_hash, expires_at, status, created_at)
         VALUES (?, ?, 'clerk-cache@example.com', 'member', 'usr_clerk_cached', ?, ?, ?, ?)`
      )
      .bind(
        `inv_${status}_${createdAt}`,
        TEST_ORG.id,
        `hash_${status}_${createdAt}`,
        new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
        status,
        createdAt
      )
      .run();
  }

  function cachedUserPayload(): ClerkJwtPayload {
    return {
      sub: "clerk_user_cached",
      org_id: "clerk_org_cached",
      org_role: "org:admin",
      org_slug: TEST_ORG.slug,
      email: "clerk-cache@example.com",
      iss: "https://clerk.example.test",
    };
  }

  it("refuses to provision a membership when the invitation was revoked", async () => {
    await getDb(env)
      .prepare("DELETE FROM organization_members WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .run();
    await seedInvitation("revoked", "2026-01-01T00:00:00.000Z");

    const { app, token } = createProtectedApp(cachedUserPayload());
    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(401);
    const membership = await getDb(env)
      .prepare("SELECT id FROM organization_members WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .first<{ id: string }>();
    expect(membership).toBeNull();
  });

  /**
   * A misconfigured Clerk JWT template stored the literal
   * `{{user.primary_email_address.email_address}}` as an identity email. It is matched
   * against `invitations.email` here, so an affected user silently missed their own
   * pending invitation: they were provisioned with the Clerk role instead of the invited
   * one, and the invitation stayed pending forever.
   */
  it("applies an invited role when the stored identity email is a template placeholder", async () => {
    await getDb(env)
      .prepare("DELETE FROM organization_members WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .run();
    await getDb(env)
      .prepare("UPDATE auth_user_identities SET email = ? WHERE id = 'aui_clerk_cached'")
      .bind("{{user.primary_email_address.email_address}}")
      .run();
    await seedInvitation("pending", "2026-02-01T00:00:00.000Z");

    // The token claims org:admin while the invitation grants member, so the invited role
    // is only visible in the result if the invitation was actually matched.
    const { app, token } = createProtectedApp(cachedUserPayload());
    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(200);

    const membership = await getDb(env)
      .prepare("SELECT role FROM organization_members WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .first<{ role: string }>();
    expect(membership?.role).toBe("member");

    const invitation = await getDb(env)
      .prepare("SELECT status FROM invitations WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .first<{ status: string }>();
    expect(invitation?.status).toBe("accepted");
  });

  /**
   * The established-user path returns before any provisioning runs, so it resolves the
   * email straight out of storage. A placeholder is a non-null string, so it would win a
   * COALESCE over the good copy sitting next to it.
   */
  it("skips a stored placeholder email for a user who is already a member", async () => {
    await getDb(env)
      .prepare("UPDATE auth_user_identities SET email = ? WHERE id = 'aui_clerk_cached'")
      .bind("{{user.primary_email_address.email_address}}")
      .run();

    const { app, token } = createProtectedApp(cachedUserPayload());
    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      organizationId: TEST_ORG.id,
      email: "clerk-cache@example.com",
    });
  });

  /**
   * Reading around the placeholder is not enough on its own. `inviteMember` matches
   * `users.email` literally, so a row left corrupted keeps letting an existing member be
   * re-invited — and the established-member path returns before `ensureClerkUser`, which
   * used to be the only thing that repaired anything.
   */
  it("repairs both stored copies for a member who is already established", async () => {
    const placeholder = "{{user.primary_email_address.email_address}}";
    await getDb(env)
      .prepare("UPDATE auth_user_identities SET email = ? WHERE id = 'aui_clerk_cached'")
      .bind(placeholder)
      .run();
    await getDb(env)
      .prepare("UPDATE users SET email = ? WHERE id = 'usr_clerk_cached'")
      .bind(placeholder)
      .run();

    const { app, token } = createProtectedApp(cachedUserPayload());
    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(res.status).toBe(200);

    const identity = await getDb(env)
      .prepare("SELECT email FROM auth_user_identities WHERE id = 'aui_clerk_cached'")
      .first<{ email: string }>();
    const user = await getDb(env)
      .prepare("SELECT email FROM users WHERE id = 'usr_clerk_cached'")
      .first<{ email: string }>();

    expect(identity?.email).toBe("clerk-cache@example.com");
    expect(user?.email).toBe("clerk-cache@example.com");
  });

  it("still provisions when a revoked invitation was superseded by a live one", async () => {
    await getDb(env)
      .prepare("DELETE FROM organization_members WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .run();
    await seedInvitation("revoked", "2026-01-01T00:00:00.000Z");
    await seedInvitation("pending", "2026-02-01T00:00:00.000Z");

    const { app, token } = createProtectedApp(cachedUserPayload());
    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    // Re-inviting a previously revoked address has to keep working.
    expect(res.status).toBe(200);
  });

  it("does not lock out an existing member carrying a stale revoked invitation", async () => {
    await seedInvitation("revoked", "2026-01-01T00:00:00.000Z");

    const { app, token } = createProtectedApp(cachedUserPayload());
    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    // The guard runs only where no membership exists, so it can decline a join
    // but never strip access from somebody who already has it.
    expect(res.status).toBe(200);
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
