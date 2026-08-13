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
