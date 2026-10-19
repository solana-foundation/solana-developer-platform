import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { getClerkAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { skipRateLimitPaths } from "@/middleware/rate-limit";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { ensureTestClerkIssuer, seedClerkIdentity, signTestClerkJwt } from "@/test/helpers/clerk";
import { env } from "@/test/helpers/env";
import { recordStatements } from "@/test/helpers/statement-log";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

/**
 * An established Clerk member's request reads the organization mapping, the
 * organization row and the member's identity, role and default projects in one
 * statement: the dashboard sends this request on every call.
 */

const CLERK_ORG_ID = "org_test_clerk_statements";
const CLERK_USER_ID = "clerk_user_statements";

async function createApp() {
  const token = await signTestClerkJwt({
    clerkUserId: CLERK_USER_ID,
    clerkOrgId: CLERK_ORG_ID,
    orgRole: "member",
    orgSlug: TEST_ORG.slug,
    email: TEST_USER.email,
    expiresInSeconds: 300,
  });
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", kvStoreMiddleware());
  app.use("*", skipRateLimitPaths());
  app.use("*", unifiedAuthMiddleware());
  app.get("/protected", (c) => c.json({ organizationId: getClerkAuth(c).organizationId }));
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toResponse(), error.statusCode as 401 | 403);
    }
    throw error;
  });

  return { app, token };
}

describe("Clerk authentication statements", () => {
  const issuerReady = ensureTestClerkIssuer(env);
  beforeEach(async () => {
    await issuerReady;
    await seedTestDatabase(env);
    await clearKVStores(env);
    const db = getDb(env);
    await db.batch([
      db
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, "active"),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(TEST_USER.id, TEST_USER.email),
    ]);
    await seedClerkIdentity(db, {
      userId: TEST_USER.id,
      email: TEST_USER.email,
      clerkUserId: CLERK_USER_ID,
      organizationId: TEST_ORG.id,
      clerkOrgId: CLERK_ORG_ID,
      orgSlug: TEST_ORG.slug,
      role: "member",
    });
  });

  it("reads an established member's organization and identity in one statement", async () => {
    const { app, token } = await createApp();
    const request = async () =>
      await app.request("/protected", { headers: { Authorization: `Bearer ${token}` } }, env);

    // The first request provisions the member's default projects.
    expect((await request()).status).toBe(200);

    const { result: response, statements } = await recordStatements(env, request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organizationId: TEST_ORG.id });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("FROM auth_organization_identities");
    expect(statements[0]).toContain("organizations o");
  });
});
