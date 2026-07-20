import { hashString } from "@sdp/payments/hash";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import { credentialAdminAuthMiddleware } from "./credential-admin-auth";

const ORG_ID = "org_credential_admin_auth";
const ADMIN_USER_ID = "usr_credential_admin_auth_admin";
const MEMBER_USER_ID = "usr_credential_admin_auth_member";

function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createJwt(payload: ClerkJwtPayload): string {
  return `${encodeJwtPart({ alg: "RS256", typ: "JWT" })}.${encodeJwtPart(payload)}.signature`;
}

function buildProbe(payload?: ClerkJwtPayload) {
  const token = createJwt(payload ?? {});
  const app = new Hono<{ Bindings: Env }>();
  let handlerReached = false;

  app.use("*", kvStoreMiddleware());
  if (payload) {
    app.use("*", async (c, next) => {
      c.set("verifiedClerkJwt", { token, payload });
      await next();
    });
  }
  app.use("*", credentialAdminAuthMiddleware());
  app.get("/probe", (c) => {
    handlerReached = true;
    return c.json({ authType: getAuth(c).authType });
  });

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toResponse(), error.statusCode as 401 | 403);
    }
    throw error;
  });

  return { app, token, wasHandlerReached: () => handlerReached };
}

describe("credentialAdminAuthMiddleware", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);

    await getDb(env).batch([
      getDb(env)
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
        )
        .bind(ORG_ID, "Credential Admin Auth Org", "credential-admin-auth-org"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(ADMIN_USER_ID, "credential-admin@example.com"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(MEMBER_USER_ID, "credential-member@example.com"),
      getDb(env)
        .prepare(
          `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
           VALUES ('aui_credential_admin_auth', 'clerk', 'clerk_user_admin', ?, 'credential-admin@example.com')`
        )
        .bind(ADMIN_USER_ID),
      getDb(env)
        .prepare(
          `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
           VALUES ('aui_credential_member_auth', 'clerk', 'clerk_user_member', ?, 'credential-member@example.com')`
        )
        .bind(MEMBER_USER_ID),
      getDb(env)
        .prepare(
          `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
           VALUES ('aoi_credential_admin_auth', 'clerk', 'clerk_org_admin', ?, 'credential-admin-auth-org')`
        )
        .bind(ORG_ID),
      getDb(env)
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES ('mem_credential_admin_auth', ?, ?, 'admin', 'active')`
        )
        .bind(ORG_ID, ADMIN_USER_ID),
      getDb(env)
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES ('mem_credential_member_auth', ?, ?, 'member', 'active')`
        )
        .bind(ORG_ID, MEMBER_USER_ID),
    ]);
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
  });

  it("allows a Clerk organization admin and exposes Clerk auth to the handler", async () => {
    const payload: ClerkJwtPayload = {
      sub: "clerk_user_admin",
      org_id: "clerk_org_admin",
      org_role: "org:admin",
      email: "credential-admin@example.com",
    };
    const { app, token } = buildProbe(payload);

    const response = await app.request(
      "/probe",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authType: "clerk" });
  });

  it("denies a Clerk organization member before the handler", async () => {
    const payload: ClerkJwtPayload = {
      sub: "clerk_user_member",
      org_id: "clerk_org_admin",
      org_role: "org:member",
      email: "credential-member@example.com",
    };
    const { app, token, wasHandlerReached } = buildProbe(payload);

    const response = await app.request(
      "/probe",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(response.status).toBe(403);
    expect(wasHandlerReached()).toBe(false);
  });

  it("returns unauthorized for a Clerk token without organization context", async () => {
    const { app, token, wasHandlerReached } = buildProbe({
      sub: "clerk_user_admin",
    });

    const response = await app.request(
      "/probe",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(response.status).toBe(401);
    expect(wasHandlerReached()).toBe(false);
  });

  it.each([
    ["standard", "api_developer", ["custody:admin"]],
    ["wildcard admin", "api_admin", ["*"]],
  ] as const)("rejects a valid %s API key before the handler", async (_label, role, permissions) => {
    const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
    await seedCachedApiKey(env, keyHash, {
      ...TEST_CACHED_API_KEY,
      role,
      permissions: [...permissions],
    });
    const { app, wasHandlerReached } = buildProbe();

    const response = await app.request(
      "/probe",
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(response.status).toBe(403);
    expect(wasHandlerReached()).toBe(false);
  });

  it("returns unauthorized for missing authentication before the handler", async () => {
    const { app, wasHandlerReached } = buildProbe();

    const response = await app.request("/probe", {}, env);

    expect(response.status).toBe(401);
    expect(wasHandlerReached()).toBe(false);
  });
});
