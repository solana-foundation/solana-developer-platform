import { hashString } from "@sdp/payments/hash";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  authenticateTestClerkUser,
  clerkHeadersWithoutProject,
  ensureTestClerkIssuer,
  signTestClerkClaims,
} from "@/test/helpers/clerk";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import { credentialAdminAuthMiddleware } from "./credential-admin-auth";

function buildProbe() {
  const app = new Hono<{ Bindings: Env }>();
  let handlerReached = false;
  app.use("*", kvStoreMiddleware());
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
  return { app, wasHandlerReached: () => handlerReached };
}

describe("credentialAdminAuthMiddleware", () => {
  const issuerReady = ensureTestClerkIssuer(env);

  beforeEach(async () => {
    await issuerReady;
    await seedTestDatabase(env);
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(TEST_USER.id, TEST_USER.email),
    ]);
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it.each([
    ["admin", 200, true],
    ["member", 403, false],
  ] as const)("gates a Clerk organization %s", async (role, status, reached) => {
    const { token } = await authenticateTestClerkUser(env, getDb(env), {
      userId: TEST_USER.id,
      email: TEST_USER.email,
      clerkUserId: "clerk_user_credential_admin",
      organizationId: TEST_ORG.id,
      clerkOrgId: "org_test_clerk_credential_admin",
      orgSlug: TEST_ORG.slug,
      role,
    });
    const { app, wasHandlerReached } = buildProbe();
    const response = await app.request(
      "/probe",
      { headers: clerkHeadersWithoutProject(token) },
      env
    );
    expect(response.status).toBe(status);
    expect(wasHandlerReached()).toBe(reached);
    if (reached) expect(await response.json()).toEqual({ authType: "clerk" });
  });

  it("returns unauthorized for a signed Clerk token without organization context", async () => {
    const token = await signTestClerkClaims(
      { sub: "clerk_user_credential_admin", v: 2, email: TEST_USER.email },
      300
    );
    const { app, wasHandlerReached } = buildProbe();
    const response = await app.request(
      "/probe",
      { headers: clerkHeadersWithoutProject(token) },
      env
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { message: "Clerk token missing organization" },
    });
    expect(wasHandlerReached()).toBe(false);
  });

  it.each([
    ["standard", "api_developer", ["custody:admin"]],
    ["wildcard admin", "api_admin", ["*"]],
  ] as const)(
    "rejects a valid %s API key before the handler",
    async (_label, role, permissions) => {
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
      expect(await response.json()).toMatchObject({
        error: {
          message: "Credential administration requires a signed-in user",
        },
      });
      expect(wasHandlerReached()).toBe(false);
    }
  );

  it("returns unauthorized for missing authentication before the handler", async () => {
    const { app, wasHandlerReached } = buildProbe();
    const response = await app.request("/probe", {}, env);
    expect(response.status).toBe(401);
    expect(wasHandlerReached()).toBe(false);
  });
});
