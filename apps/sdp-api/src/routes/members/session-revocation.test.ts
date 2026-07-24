import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { SessionService } from "@/services/session.service";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

describe("member session revocation", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVStores(env);
  });

  it("revokes the removed member's sessions without affecting the administrator", async () => {
    const db = getDb(env);
    const organizationId = TEST_CACHED_API_KEY.organizationId;
    const projectId = TEST_CACHED_API_KEY.projectId;
    const administratorId = "usr_member_removal_admin";
    const removedUserId = "usr_member_removal_target";
    const removedMemberId = "mem_member_removal_target";
    const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);

    await db.batch([
      db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Member Removal', 'member-removal', 'individual', 'active')"
        )
        .bind(organizationId),
      db
        .prepare(
          "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'member-removal-admin@example.com', 1, 'active')"
        )
        .bind(administratorId),
      db
        .prepare(
          "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'member-removal-target@example.com', 1, 'active')"
        )
        .bind(removedUserId),
      db
        .prepare(
          "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES ('mem_member_removal_admin', ?, ?, 'admin', 'active')"
        )
        .bind(organizationId, administratorId),
      db
        .prepare(
          "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, 'member', 'active')"
        )
        .bind(removedMemberId, organizationId, removedUserId),
      db
        .prepare(
          `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Member Removal', 'member-removal', 'sandbox', 'active', ?)`
        )
        .bind(projectId, organizationId, administratorId),
    ]);
    await seedCachedApiKey(env, keyHash, {
      ...TEST_CACHED_API_KEY,
      organizationId,
      projectId,
      permissions: ["*"],
    });

    const sessionService = new SessionService(db);
    const removedUserSession = await sessionService.createSession(
      removedUserId,
      organizationId,
      {}
    );
    const administratorSession = await sessionService.createSession(
      administratorId,
      organizationId,
      {}
    );

    const response = await app.request(
      `/v1/members/${removedMemberId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(response.status).toBe(204);
    const persisted = await db
      .prepare("SELECT id, revoked_at FROM sessions")
      .all<{ id: string; revoked_at: string | null }>();
    const revokedById = new Map(persisted.results.map((row) => [row.id, row.revoked_at]));
    expect(revokedById.get(removedUserSession.id)).not.toBeNull();
    expect(revokedById.get(administratorSession.id)).toBeNull();
  });
});
