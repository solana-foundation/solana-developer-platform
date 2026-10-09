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

/**
 * An SDP organization deletion leaves the Clerk organization in place, so a
 * Clerk member can still present a valid token for it. Without the status
 * check on the door's organization read, signing in provisioned a fresh
 * active membership (and default projects) in the deleted organization.
 */

const ORG_ID = TEST_ORG.id;
const CLERK_ORG_ID = "org_test_clerk_deleted";
const CLERK_USER_ID = "clerk_user_deleted_org";
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

describe("Clerk auth into a deleted organization", () => {
  const issuerReady = ensureTestClerkIssuer(env);
  beforeEach(async () => {
    await issuerReady;
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.batch([
      db
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, "active"),
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
    // A Clerk member with no SDP membership: the path that provisions one.
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
      .prepare(
        "SELECT COUNT(*) AS total FROM organization_members WHERE organization_id = ? AND status = 'active'"
      )
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

  async function deleteOrganization(): Promise<void> {
    await getDb(env)
      .prepare("UPDATE organizations SET status = 'deleted' WHERE id = ?")
      .bind(ORG_ID)
      .run();
  }

  it("refuses a member of a deleted organization before provisioning anything", async () => {
    await deleteOrganization();
    const { app, token } = await createApp();

    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(401);
    expect(await provisionedRows()).toEqual({ memberships: 0, projects: 0 });
  });

  it("refuses a membership re-activated after the deletion", async () => {
    // A Clerk membership webhook re-activates a removed row without looking
    // at the organization; the door must still refuse.
    await getDb(env)
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES ('om_reactivated', ?, ?, 'member', 'active')`
      )
      .bind(ORG_ID, USER_ID)
      .run();
    await deleteOrganization();
    const { app, token } = await createApp();

    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(401);
  });

  it("still provisions a member of an active organization", async () => {
    const { app, token } = await createApp();

    const res = await app.request(
      "/protected",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ organizationId: ORG_ID });
    expect((await provisionedRows()).memberships).toBe(1);
  });
});
