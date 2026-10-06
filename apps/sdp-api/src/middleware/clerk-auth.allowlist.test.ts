import assert from "node:assert/strict";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { getClerkAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { skipRateLimitPaths } from "@/middleware/rate-limit";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { ensureTestClerkIssuer, seedClerkIdentity, signTestClerkJwt } from "@/test/helpers/clerk";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

const ORG_ID = TEST_ORG.id;
const CLERK_ORG_ID = "org_test_clerk_allowlist";
const CLERK_USER_ID = "clerk_user_allowlist";
const USER_ID = TEST_USER.id;
const EMAIL = TEST_USER.email;

async function createApp() {
  const token = await signTestClerkJwt({
    clerkUserId: CLERK_USER_ID,
    clerkOrgId: CLERK_ORG_ID,
    orgRole: "member",
    orgSlug: TEST_ORG.slug,
    email: EMAIL,
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

describe("Clerk auth against the organization IP allowlist", () => {
  const issuerReady = ensureTestClerkIssuer(env);
  beforeEach(async () => {
    await issuerReady;
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(
          TEST_ORG.id,
          TEST_ORG.name,
          TEST_ORG.slug,
          TEST_ORG.tier,
          TEST_ORG.status,
          JSON.stringify({ allowedIpAddresses: ["203.0.113.0/24"] })
        ),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(USER_ID, EMAIL),
    ]);
    await seedClerkIdentity(db, {
      userId: USER_ID,
      email: EMAIL,
      clerkUserId: CLERK_USER_ID,
      organizationId: ORG_ID,
      clerkOrgId: CLERK_ORG_ID,
      orgSlug: TEST_ORG.slug,
      role: "member",
    });
    await db
      .prepare("DELETE FROM organization_members WHERE organization_id = ?")
      .bind(ORG_ID)
      .run();
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  async function provisionedRows(): Promise<{ memberships: number; projects: number }> {
    const memberships = await getDb(env)
      .prepare("SELECT COUNT(*) AS total FROM organization_members WHERE organization_id = ?")
      .bind(ORG_ID)
      .first<{ total: number }>();
    const projects = await getDb(env)
      .prepare("SELECT COUNT(*) AS total FROM projects WHERE organization_id = ?")
      .bind(ORG_ID)
      .first<{ total: number }>();

    assert(memberships !== null);
    assert(projects !== null);
    return { memberships: Number(memberships.total), projects: Number(projects.total) };
  }

  it("refuses a blocked origin before provisioning anything", async () => {
    const { app, token } = await createApp();

    const res = await app.request(
      "/protected",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-forwarded-for": "198.51.100.42",
        },
      },
      env
    );

    expect(res.status).toBe(403);

    expect(await provisionedRows()).toEqual({ memberships: 0, projects: 0 });
  });

  it("provisions normally from an allowed origin", async () => {
    const { app, token } = await createApp();

    const res = await app.request(
      "/protected",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-forwarded-for": "203.0.113.42",
        },
      },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizationId: ORG_ID });

    const rows = await provisionedRows();
    expect(rows.memberships).toBe(1);
    expect(rows.projects).toBeGreaterThan(0);
  });
});
