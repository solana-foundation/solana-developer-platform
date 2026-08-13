import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { NotificationsRepository } from "./notification.repository";
import { createPostgresNotificationsRepository } from "./notification.repository.postgres";

const SECOND_USER_ID = "usr_notif_repo_second";

describe("NotificationsRepository (postgres)", () => {
  let repo: NotificationsRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM notifications").run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    for (const [id, email] of [
      [TEST_USER.id, TEST_USER.email],
      [SECOND_USER_ID, "second-notif@example.com"],
    ]) {
      await db
        .prepare(
          "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
        )
        .bind(id, email)
        .run();
    }
    repo = createPostgresNotificationsRepository(db);
  });

  function input(userId: string, dedupeKey?: string) {
    return {
      organizationId: TEST_ORG.id,
      userId,
      type: "workflow_execution",
      title: "Test notification",
      dedupeKey,
    };
  }

  it("createMany dedupes on (user, dedupeKey) across calls", async () => {
    expect(
      await repo.createMany([input(TEST_USER.id, "evt:1"), input(SECOND_USER_ID, "evt:2")])
    ).toBe(2);
    // Retried producer: same keys insert nothing.
    expect(
      await repo.createMany([input(TEST_USER.id, "evt:1"), input(SECOND_USER_ID, "evt:2")])
    ).toBe(0);
  });

  it("lists strictly newest-first, unmoved by read state", async () => {
    const db = getDb(env);
    for (const [id, createdAt] of [
      ["ntf_ord_1", "2026-08-01T00:00:00.000Z"],
      ["ntf_ord_2", "2026-08-02T00:00:00.000Z"],
      ["ntf_ord_3", "2026-08-03T00:00:00.000Z"],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO notifications (id, organization_id, user_id, type, title, dedupe_key, created_at)
           VALUES (?, ?, ?, 'workflow_execution', 'T', ?, ?)`
        )
        .bind(id, TEST_ORG.id, TEST_USER.id, `${id}:key`, createdAt)
        .run();
    }
    const before = await repo.listForUser({
      organizationId: TEST_ORG.id,
      userId: TEST_USER.id,
      unreadOnly: false,
      limit: 10,
      offset: 0,
    });
    expect(before.rows.map((row) => row.id)).toEqual(["ntf_ord_3", "ntf_ord_2", "ntf_ord_1"]);

    // Reading the newest row must NOT re-sort: the bell pages by offset, and a
    // read-state sort key shifted rows between pages, silently skipping some.
    await repo.markRead({
      notificationId: "ntf_ord_3",
      organizationId: TEST_ORG.id,
      userId: TEST_USER.id,
    });
    const after = await repo.listForUser({
      organizationId: TEST_ORG.id,
      userId: TEST_USER.id,
      unreadOnly: false,
      limit: 10,
      offset: 0,
    });
    expect(after.rows.map((row) => row.id)).toEqual(["ntf_ord_3", "ntf_ord_2", "ntf_ord_1"]);
  });

  it("countUnreadForUsers groups per user and zero-fills absentees", async () => {
    await repo.createMany([
      input(TEST_USER.id, "a:1"),
      input(TEST_USER.id, "a:2"),
      input(SECOND_USER_ID, "b:1"),
    ]);
    const read = await repo.create(input(SECOND_USER_ID, "b:2"));
    if (!read) throw new Error("expected created row");
    await repo.markRead({
      notificationId: read.id,
      organizationId: TEST_ORG.id,
      userId: SECOND_USER_ID,
    });

    const counts = await repo.countUnreadForUsers({
      organizationId: TEST_ORG.id,
      userIds: [TEST_USER.id, SECOND_USER_ID, "usr_never_notified"],
    });
    expect(counts.get(TEST_USER.id)).toBe(2);
    expect(counts.get(SECOND_USER_ID)).toBe(1);
    // Present with 0, not missing — nudge payloads read this directly.
    expect(counts.get("usr_never_notified")).toBe(0);
  });
});
