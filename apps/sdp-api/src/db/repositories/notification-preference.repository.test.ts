import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { NotificationPreferencesRepository } from "./notification-preference.repository";
import { createPostgresNotificationPreferencesRepository } from "./notification-preference.repository.postgres";

const OTHER_ORG_ID = "org_pref_repo_other";
const OTHER_USER_ID = "usr_pref_repo_other";

describe("NotificationPreferencesRepository (postgres)", () => {
  let repo: NotificationPreferencesRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM notification_preferences").run();
    for (const org of [TEST_ORG.id, OTHER_ORG_ID]) {
      await db
        .prepare(
          "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
        )
        .bind(org, `Org ${org}`, org)
        .run();
    }
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(OTHER_USER_ID, "other-pref@example.com")
      .run();
    repo = createPostgresNotificationPreferencesRepository(db);
  });

  it("upserts override cells and lists them back", async () => {
    await repo.upsertMany({
      organizationId: TEST_ORG.id,
      userId: TEST_USER.id,
      entries: [
        { category: "workflows", channel: "email", enabled: false },
        { category: "payments", channel: "in_app", enabled: false },
      ],
    });

    const rows = await repo.listForUser({ organizationId: TEST_ORG.id, userId: TEST_USER.id });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => `${row.category}:${row.channel}:${row.enabled}`).sort()).toEqual([
      "payments:in_app:false",
      "workflows:email:false",
    ]);
  });

  it("re-upserting the same cell updates enabled instead of duplicating", async () => {
    const cell = { category: "workflows", channel: "email", enabled: false };
    await repo.upsertMany({ organizationId: TEST_ORG.id, userId: TEST_USER.id, entries: [cell] });
    await repo.upsertMany({
      organizationId: TEST_ORG.id,
      userId: TEST_USER.id,
      entries: [{ ...cell, enabled: true }],
    });

    const rows = await repo.listForUser({ organizationId: TEST_ORG.id, userId: TEST_USER.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(true);
  });

  it("listDisabledUserIds returns only the queried (org, category, channel) matches", async () => {
    await repo.upsertMany({
      organizationId: TEST_ORG.id,
      userId: TEST_USER.id,
      entries: [{ category: "workflows", channel: "email", enabled: false }],
    });
    // Different channel, different category, different org, and an explicit re-enable —
    // none of these may leak into the queried cell.
    await repo.upsertMany({
      organizationId: TEST_ORG.id,
      userId: TEST_USER.id,
      entries: [{ category: "workflows", channel: "in_app", enabled: true }],
    });
    await repo.upsertMany({
      organizationId: TEST_ORG.id,
      userId: OTHER_USER_ID,
      entries: [{ category: "payments", channel: "email", enabled: false }],
    });
    await repo.upsertMany({
      organizationId: OTHER_ORG_ID,
      userId: OTHER_USER_ID,
      entries: [{ category: "workflows", channel: "email", enabled: false }],
    });

    const disabled = await repo.listDisabledUserIds({
      organizationId: TEST_ORG.id,
      category: "workflows",
      channel: "email",
      userIds: [TEST_USER.id, OTHER_USER_ID],
    });
    expect(disabled).toEqual(new Set([TEST_USER.id]));

    const none = await repo.listDisabledUserIds({
      organizationId: TEST_ORG.id,
      category: "workflows",
      channel: "email",
      userIds: [],
    });
    expect(none.size).toBe(0);
  });
});
