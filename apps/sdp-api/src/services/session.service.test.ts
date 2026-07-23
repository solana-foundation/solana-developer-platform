import { getPermissionsForOrgRole } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { KVStore } from "@/runtime/kv";
import { createKVStoreSet } from "@/runtime/kv-redis";
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

    service = new SessionService(db, createKVStoreSet(env).sessions);
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVStores(env);
  });

  it("rejects a removed member even when an authorized session is still cached", async () => {
    const session = await service.createSession(
      USER_ONE,
      ORG_ONE,
      getPermissionsForOrgRole("admin"),
      {}
    );

    await getDb(env)
      .prepare(
        "UPDATE organization_members SET status = 'removed' WHERE organization_id = ? AND user_id = ?"
      )
      .bind(ORG_ONE, USER_ONE)
      .run();

    await expect(service.getSession(session.id)).resolves.toBeNull();
    await expect(createKVStoreSet(env).sessions.get(`session:${session.id}`)).resolves.toBeNull();
  });

  it("refreshes cached permissions from the member's current role", async () => {
    const sessions = createKVStoreSet(env).sessions;
    const session = await service.createSession(
      USER_ONE,
      ORG_ONE,
      getPermissionsForOrgRole("admin"),
      {}
    );

    await getDb(env)
      .prepare(
        "UPDATE organization_members SET role = 'member' WHERE organization_id = ? AND user_id = ?"
      )
      .bind(ORG_ONE, USER_ONE)
      .run();

    const refreshed = await service.getSession(session.id);
    expect(refreshed?.permissions).toEqual(getPermissionsForOrgRole("member"));
    expect(refreshed?.permissions).not.toContain("org:admin");

    const cached = await sessions.get<{ permissions: string[] }>(`session:${session.id}`, "json");
    expect(cached?.permissions).toEqual(getPermissionsForOrgRole("member"));
  });

  it("revokes only the user's sessions in the removed organization", async () => {
    const target = await service.createSession(
      USER_ONE,
      ORG_ONE,
      getPermissionsForOrgRole("admin"),
      {}
    );
    const sameUserOtherOrg = await service.createSession(
      USER_ONE,
      ORG_TWO,
      getPermissionsForOrgRole("admin"),
      {}
    );
    const otherUserSameOrg = await service.createSession(
      USER_TWO,
      ORG_ONE,
      getPermissionsForOrgRole("member"),
      {}
    );

    await service.revokeUserOrganizationSessions(USER_ONE, ORG_ONE);

    const rows = await getDb(env)
      .prepare("SELECT id, revoked_at FROM sessions")
      .all<{ id: string; revoked_at: string | null }>();
    const revokedById = new Map(rows.results.map((row) => [row.id, row.revoked_at]));

    expect(revokedById.get(target.id)).not.toBeNull();
    expect(revokedById.get(sameUserOtherOrg.id)).toBeNull();
    expect(revokedById.get(otherUserSameOrg.id)).toBeNull();
    await expect(createKVStoreSet(env).sessions.get(`session:${target.id}`)).resolves.toBeNull();
  });

  it("revokes every session in a deleted organization without affecting other organizations", async () => {
    const firstOrgSession = await service.createSession(
      USER_ONE,
      ORG_ONE,
      getPermissionsForOrgRole("admin"),
      {}
    );
    const secondOrgSession = await service.createSession(
      USER_ONE,
      ORG_TWO,
      getPermissionsForOrgRole("admin"),
      {}
    );
    const otherUserFirstOrgSession = await service.createSession(
      USER_TWO,
      ORG_ONE,
      getPermissionsForOrgRole("member"),
      {}
    );

    await service.revokeOrganizationSessions(ORG_ONE);

    const rows = await getDb(env)
      .prepare("SELECT id, revoked_at FROM sessions")
      .all<{ id: string; revoked_at: string | null }>();
    const revokedById = new Map(rows.results.map((row) => [row.id, row.revoked_at]));

    expect(revokedById.get(firstOrgSession.id)).not.toBeNull();
    expect(revokedById.get(otherUserFirstOrgSession.id)).not.toBeNull();
    expect(revokedById.get(secondOrgSession.id)).toBeNull();
  });

  it("keeps committed revocation successful when cache cleanup is unavailable", async () => {
    const sessions = createKVStoreSet(env).sessions;
    const session = await service.createSession(
      USER_ONE,
      ORG_ONE,
      getPermissionsForOrgRole("admin"),
      {}
    );
    const failingCache: KVStore = {
      get: sessions.get.bind(sessions),
      put: sessions.put.bind(sessions),
      delete: async () => {
        throw new Error("Redis unavailable");
      },
      list: sessions.list.bind(sessions),
      admitSlidingWindow: sessions.admitSlidingWindow.bind(sessions),
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const serviceWithFailingCache = new SessionService(getDb(env), failingCache);

    await expect(
      serviceWithFailingCache.revokeUserOrganizationSessions(USER_ONE, ORG_ONE)
    ).resolves.toBeUndefined();

    const persisted = await getDb(env)
      .prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(session.id)
      .first<{ revoked_at: string | null }>();
    expect(persisted?.revoked_at).not.toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to delete revoked session cache:",
      expect.any(Error)
    );

    await expect(serviceWithFailingCache.getSession(session.id)).resolves.toBeNull();
  });
});
