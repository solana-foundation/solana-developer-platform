import { getPermissionsForOrgRole } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import { SessionService } from "./session.service";

const USER_ONE = "usr_session_one";
const USER_TWO = "usr_session_two";
const ORG_ONE = "org_session_one";
const ORG_TWO = "org_session_two";

describe("SessionService", () => {
  let service: SessionService;

  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);

    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
        )
        .bind(ORG_ONE, "Session Org One", "session-org-one"),
      db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
        )
        .bind(ORG_TWO, "Session Org Two", "session-org-two"),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(USER_ONE, "session-one@example.com"),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(USER_TWO, "session-two@example.com"),
      db
        .prepare(
          "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, 'admin', 'active')"
        )
        .bind("mem_session_one_one", ORG_ONE, USER_ONE),
      db
        .prepare(
          "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, 'admin', 'active')"
        )
        .bind("mem_session_one_two", ORG_TWO, USER_ONE),
      db
        .prepare(
          "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, 'member', 'active')"
        )
        .bind("mem_session_two_one", ORG_ONE, USER_TWO),
    ]);

    service = new SessionService(db);
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVStores(env);
  });

  it("rejects a removed member with an otherwise valid session", async () => {
    const session = await service.createSession(USER_ONE, ORG_ONE, {});

    await getDb(env)
      .prepare(
        "UPDATE organization_members SET status = 'removed' WHERE organization_id = ? AND user_id = ?"
      )
      .bind(ORG_ONE, USER_ONE)
      .run();

    await expect(service.getSession(session.id)).resolves.toBeNull();
  });

  it("resolves permissions from the member's current role", async () => {
    const session = await service.createSession(USER_ONE, ORG_ONE, {});

    await getDb(env)
      .prepare(
        "UPDATE organization_members SET role = 'member' WHERE organization_id = ? AND user_id = ?"
      )
      .bind(ORG_ONE, USER_ONE)
      .run();

    const refreshed = await service.getSession(session.id);
    expect(refreshed?.permissions).toEqual(getPermissionsForOrgRole("member"));
    expect(refreshed?.permissions).not.toContain("org:admin");
  });

  it("revokes only the user's sessions in the removed organization", async () => {
    const target = await service.createSession(USER_ONE, ORG_ONE, {});
    const sameUserOtherOrg = await service.createSession(USER_ONE, ORG_TWO, {});
    const otherUserSameOrg = await service.createSession(USER_TWO, ORG_ONE, {});

    await service.revokeUserOrganizationSessions(USER_ONE, ORG_ONE);

    const rows = await getDb(env)
      .prepare("SELECT id, revoked_at FROM sessions")
      .all<{ id: string; revoked_at: string | null }>();
    const revokedById = new Map(rows.results.map((row) => [row.id, row.revoked_at]));

    expect(revokedById.get(target.id)).not.toBeNull();
    expect(revokedById.get(sameUserOtherOrg.id)).toBeNull();
    expect(revokedById.get(otherUserSameOrg.id)).toBeNull();
  });

  it("revokes every session in a deleted organization without affecting other organizations", async () => {
    const firstOrgSession = await service.createSession(USER_ONE, ORG_ONE, {});
    const secondOrgSession = await service.createSession(USER_ONE, ORG_TWO, {});
    const otherUserFirstOrgSession = await service.createSession(USER_TWO, ORG_ONE, {});

    await service.revokeOrganizationSessions(ORG_ONE);

    const rows = await getDb(env)
      .prepare("SELECT id, revoked_at FROM sessions")
      .all<{ id: string; revoked_at: string | null }>();
    const revokedById = new Map(rows.results.map((row) => [row.id, row.revoked_at]));

    expect(revokedById.get(firstOrgSession.id)).not.toBeNull();
    expect(revokedById.get(otherUserFirstOrgSession.id)).not.toBeNull();
    expect(revokedById.get(secondOrgSession.id)).toBeNull();
  });
});
