import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { getClerkAuth } from "@/lib/auth";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { optionalClerkAuth } from "@/middleware/clerk-auth";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { DASHBOARD_ACTOR_MAX_REQUESTS, skipRateLimitPaths } from "@/middleware/rate-limit";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  ensureTestClerkIssuer,
  seedClerkIdentity,
  signTestClerkClaims,
} from "@/test/helpers/clerk";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, readRateLimitCount, seedRateLimit } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

describe("Clerk auth request cache", () => {
  const issuerReady = ensureTestClerkIssuer(env);
  const apiServers: Server[] = [];

  async function serveClerkApi(path: string, responseBody: () => unknown) {
    const server = createServer((request, response) => {
      if (!(request.method === "GET" && request.url === path)) {
        response.writeHead(500);
        response.end("Unexpected Clerk API request");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(responseBody()));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    apiServers.push(server);
    const address = server.address();
    assert(address !== null && typeof address === "object");
    env.CLERK_API_URL = `http://127.0.0.1:${address.port}/v1`;
  }

  beforeEach(async () => {
    await issuerReady;
    await ensureTestClerkIssuer(env);
    await seedTestDatabase(env);
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(TEST_USER.id, TEST_USER.email),
    ]);
    await seedClerkIdentity(getDb(env), {
      userId: TEST_USER.id,
      email: TEST_USER.email,
      clerkUserId: "clerk_user_cached",
      organizationId: TEST_ORG.id,
      clerkOrgId: "org_test_clerk_cached",
      orgSlug: TEST_ORG.slug,
      role: "admin",
    });
  });

  afterEach(async () => {
    await Promise.all(
      apiServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          })
      )
    );
    await clearKVStores(env);
    env.CLERK_ISSUER = undefined;
    env.CLERK_SECRET_KEY = undefined;
    env.CLERK_API_URL = undefined;
  });

  async function createProtectedApp(payload: ClerkJwtPayload) {
    const token = await signTestClerkClaims(payload, 300);
    const app = new Hono<{ Bindings: Env }>();
    let cachedBeforeAuth: ClerkJwtPayload | undefined;
    let cachedAfterAuth: ClerkJwtPayload | undefined;

    app.use("*", kvStoreMiddleware());
    app.use("*", skipRateLimitPaths());
    app.use("*", async (c, next) => {
      const verified = c.get("verifiedClerkJwt");
      assert(verified !== undefined);
      cachedBeforeAuth = verified.payload;
      await next();
      const after = c.get("verifiedClerkJwt");
      assert(after !== undefined);
      cachedAfterAuth = after.payload;
    });
    app.use("*", unifiedAuthMiddleware());
    app.get("/protected", requirePermissions("org:read"), (c) => {
      return c.json({
        organizationId: getClerkAuth(c).organizationId,
        email: getClerkAuth(c).email,
      });
    });
    app.get("/admin", requirePermissions("org:admin"), (c) => {
      return c.json({ role: getClerkAuth(c).role });
    });
    app.onError((error, c) => {
      if (error instanceof AppError) {
        return c.json(error.toResponse(), error.statusCode as 401 | 403);
      }
      throw error;
    });

    return {
      app,
      token,
      cachedPayloads: () => ({ before: cachedBeforeAuth, after: cachedAfterAuth }),
    };
  }

  async function createStrictOptionalApp(payload: ClerkJwtPayload) {
    const token = await signTestClerkClaims(payload, 300);
    const app = new Hono<{ Bindings: Env }>();

    app.use("*", optionalClerkAuth({ rejectInvalid: true }));
    app.get("/optional", (c) => c.json({ authenticated: Boolean(c.get("clerk")) }));
    app.onError((error, c) => {
      if (error instanceof AppError) {
        return c.json(error.toResponse(), error.statusCode as 401);
      }
      throw error;
    });

    return { app, token };
  }

  it("strict optional auth rejects a verified Clerk token without an organization", async () => {
    const payload: ClerkJwtPayload = {
      sub: "clerk_user_without_org",
    };
    const { app, token } = await createStrictOptionalApp(payload);

    const res = await app.request(
      "/optional",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Clerk token missing organization" },
    });
  });

  it("strict optional auth returns unauthorized for a malformed bearer token", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", optionalClerkAuth({ rejectInvalid: true }));
    app.get("/optional", (c) => c.json({ authenticated: Boolean(c.get("clerk")) }));
    app.onError((error, c) => {
      if (error instanceof AppError) {
        return c.json(error.toResponse(), error.statusCode as 401);
      }
      throw error;
    });

    const res = await app.request(
      "/optional",
      { headers: { Authorization: "Bearer invalid" } },
      env
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "UNAUTHORIZED", message: "Invalid Clerk token" },
    });
  });

  it("reuses a cached Clerk JWT across rate limiting and auth in one request", async () => {
    const payload: ClerkJwtPayload = {
      sub: "clerk_user_cached",
      v: 2,
      o: { id: "org_test_clerk_cached", rol: "admin", slg: TEST_ORG.slug },
      email: TEST_USER.email,
    };
    const { app, token, cachedPayloads } = await createProtectedApp(payload);

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
    const cached = cachedPayloads();
    assert(cached.before !== undefined);
    expect(cached.after).toBe(cached.before);
    expect(await res.json()).toEqual({
      organizationId: TEST_ORG.id,
      email: TEST_USER.email,
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

  it("provisions a second administrator from Clerk v2 organization claims", async () => {
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind("usr_test_clerk_second_admin", "second-admin@example.com"),
      getDb(env)
        .prepare(
          `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
           VALUES (?, 'clerk', ?, ?, ?)`
        )
        .bind(
          "aui_clerk_second_admin",
          "clerk_user_second_admin",
          "usr_test_clerk_second_admin",
          "second-admin@example.com"
        ),
    ]);

    const payload: ClerkJwtPayload = {
      sub: "clerk_user_second_admin",
      v: 2,
      o: {
        id: "org_test_clerk_cached",
        rol: "admin",
        slg: TEST_ORG.slug,
      },
      email: "second-admin@example.com",
    };
    const { app, token } = await createProtectedApp(payload);

    const res = await app.request("/admin", { headers: { Authorization: `Bearer ${token}` } }, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "admin" });
    const membership = await getDb(env)
      .prepare("SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?")
      .bind(TEST_ORG.id, "usr_test_clerk_second_admin")
      .first<{ role: string }>();
    assert(membership !== null);
    expect(membership.role).toBe("admin");
  });

  it("counts Clerk dashboard requests against a per-user per-org limit", async () => {
    const payload: ClerkJwtPayload = {
      sub: "clerk_user_cached",
      v: 2,
      o: { id: "org_test_clerk_cached", rol: "admin", slg: TEST_ORG.slug },
      email: TEST_USER.email,
    };
    const { app, token } = await createProtectedApp(payload);

    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(200);
    expect(await readRateLimitCount(env, `user:${TEST_USER.id}:org:${TEST_ORG.id}`)).toBe(1);
  });

  it("429s Clerk dashboard traffic once the per-user limit is exhausted", async () => {
    const payload: ClerkJwtPayload = {
      sub: "clerk_user_cached",
      v: 2,
      o: { id: "org_test_clerk_cached", rol: "admin", slg: TEST_ORG.slug },
      email: TEST_USER.email,
    };
    const { app, token } = await createProtectedApp(payload);
    await seedRateLimit(
      env,
      `user:${TEST_USER.id}:org:${TEST_ORG.id}`,
      DASHBOARD_ACTOR_MAX_REQUESTS
    );

    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });

  it("rejects a stale Clerk JWT after the local organization membership is removed", async () => {
    await getDb(env)
      .prepare(
        "UPDATE organization_members SET status = 'removed' WHERE organization_id = ? AND user_id = ?"
      )
      .bind(TEST_ORG.id, TEST_USER.id)
      .run();

    const payload: ClerkJwtPayload = {
      sub: "clerk_user_cached",
      v: 2,
      o: { id: "org_test_clerk_cached", rol: "admin", slg: TEST_ORG.slug },
      email: TEST_USER.email,
    };
    const { app, token } = await createProtectedApp(payload);

    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(401);
    const membership = await getDb(env)
      .prepare("SELECT status FROM organization_members WHERE organization_id = ? AND user_id = ?")
      .bind(TEST_ORG.id, TEST_USER.id)
      .first<{ status: string }>();
    assert(membership !== null);
    expect(membership.status).toBe("removed");
  });

  it("does not link a first-time Clerk identity until its primary email is verified", async () => {
    await getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind("usr_test_email_collision_target", "collision-target@example.com")
      .run();

    env.CLERK_SECRET_KEY = "sk_test_clerk_auth_user_lookup";
    let verificationStatus = "unverified";
    await serveClerkApi("/v1/users/clerk_user_first_login", () => ({
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
    }));

    const payload: ClerkJwtPayload = {
      sub: "clerk_user_first_login",
      v: 2,
      o: { id: "org_test_clerk_cached", rol: "member", slg: TEST_ORG.slug },
      email: "collision-target@example.com",
    };
    const { app, token } = await createProtectedApp(payload);

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
    assert(linkedIdentity !== null);
    expect(linkedIdentity.user_id).toBe("usr_test_email_collision_target");
  });

  it("provisions default projects when the membership webhook has not arrived", async () => {
    await getDb(env)
      .prepare("DELETE FROM organization_members WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .run();

    const payload: ClerkJwtPayload = {
      sub: "clerk_user_cached",
      v: 2,
      o: { id: "org_test_clerk_cached", rol: "admin", slg: TEST_ORG.slug },
      email: TEST_USER.email,
    };
    const { app, token } = await createProtectedApp(payload);

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

  async function seedInvitation(status: string, createdAt: string, expiresInDays: number) {
    await getDb(env)
      .prepare(
        `INSERT INTO invitations
           (id, organization_id, email, role, invited_by, token_hash, expires_at, status, created_at)
         VALUES (?, ?, ?, 'member', ?, ?, ?, ?, ?)`
      )
      .bind(
        `inv_${status}_${createdAt}`,
        TEST_ORG.id,
        TEST_USER.email,
        TEST_USER.id,
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
      v: 2,
      o: { id: "org_test_clerk_cached", rol: "admin", slg: TEST_ORG.slug },
      email: TEST_USER.email,
    };
  }

  it("refuses to provision a membership when the invitation was revoked", async () => {
    await getDb(env)
      .prepare("DELETE FROM organization_members WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .run();
    await seedInvitation("revoked", "2026-01-01T00:00:00.000Z", 7);

    const { app, token } = await createProtectedApp(cachedUserPayload());
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

  it("applies an invited role when the stored identity email is a template placeholder", async () => {
    await getDb(env)
      .prepare("DELETE FROM organization_members WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .run();
    await getDb(env)
      .prepare("UPDATE auth_user_identities SET email = ? WHERE id = 'aui_test_clerk_user_cached'")
      .bind("{{user.primary_email_address.email_address}}")
      .run();
    await seedInvitation("pending", "2026-02-01T00:00:00.000Z", 7);

    const { app, token } = await createProtectedApp(cachedUserPayload());
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
    assert(membership !== null);
    expect(membership.role).toBe("member");

    const invitation = await getDb(env)
      .prepare("SELECT status FROM invitations WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .first<{ status: string }>();
    assert(invitation !== null);
    expect(invitation.status).toBe("accepted");
  });

  it("skips a stored placeholder email for a user who is already a member", async () => {
    await getDb(env)
      .prepare("UPDATE auth_user_identities SET email = ? WHERE id = 'aui_test_clerk_user_cached'")
      .bind("{{user.primary_email_address.email_address}}")
      .run();

    const { app, token } = await createProtectedApp(cachedUserPayload());
    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      organizationId: TEST_ORG.id,
      email: TEST_USER.email,
    });
  });

  it("repairs both stored copies for a member who is already established", async () => {
    const placeholder = "{{user.primary_email_address.email_address}}";
    await getDb(env)
      .prepare("UPDATE auth_user_identities SET email = ? WHERE id = 'aui_test_clerk_user_cached'")
      .bind(placeholder)
      .run();
    await getDb(env)
      .prepare("UPDATE users SET email = ? WHERE id = ?")
      .bind(placeholder, TEST_USER.id)
      .run();

    const { app, token } = await createProtectedApp(cachedUserPayload());
    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(res.status).toBe(200);

    const identity = await getDb(env)
      .prepare("SELECT email FROM auth_user_identities WHERE id = 'aui_test_clerk_user_cached'")
      .first<{ email: string }>();
    const user = await getDb(env)
      .prepare("SELECT email FROM users WHERE id = ?")
      .bind(TEST_USER.id)
      .first<{ email: string }>();

    assert(identity !== null);
    expect(identity.email).toBe(TEST_USER.email);
    assert(user !== null);
    expect(user.email).toBe(TEST_USER.email);
  });

  it("still provisions when a revoked invitation was superseded by a live one", async () => {
    await getDb(env)
      .prepare("DELETE FROM organization_members WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .run();
    await seedInvitation("revoked", "2026-01-01T00:00:00.000Z", 7);
    await seedInvitation("pending", "2026-02-01T00:00:00.000Z", 7);

    const { app, token } = await createProtectedApp(cachedUserPayload());
    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(200);
  });

  it("does not lock out an existing member carrying a stale revoked invitation", async () => {
    await seedInvitation("revoked", "2026-01-01T00:00:00.000Z", 7);

    const { app, token } = await createProtectedApp(cachedUserPayload());
    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(200);
  });

  it("bootstraps an unlinked Clerk organization on the first authenticated request", async () => {
    env.CLERK_SECRET_KEY = "sk_test_clerk_auth_bootstrap";
    await serveClerkApi("/v1/organizations/org_test_clerk_new", () => ({
      id: "org_test_clerk_new",
      name: "New Clerk Organization",
      slug: "new-clerk-organization",
      private_metadata: {
        sdp: { tier: "enterprise", providerOverrides: { ramps: { coinbase: false } } },
      },
    }));

    const payload: ClerkJwtPayload = {
      sub: "clerk_user_cached",
      v: 2,
      o: { id: "org_test_clerk_new", rol: "admin", slg: "new-clerk-organization" },
      email: TEST_USER.email,
    };
    const { app, token } = await createProtectedApp(payload);

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
      .bind("org_test_clerk_new")
      .first<{ organization_id: string }>();
    assert(mapping !== null);
    expect(mapping.organization_id).toBe(body.organizationId);

    const organization = await getDb(env)
      .prepare("SELECT tier, settings FROM organizations WHERE id = ?")
      .bind(body.organizationId)
      .first<{ tier: string; settings: string | null }>();
    assert(organization !== null);
    expect(organization.tier).toBe("enterprise");
    assert(typeof organization.settings === "string");
    expect(JSON.parse(organization.settings)).toEqual({
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
