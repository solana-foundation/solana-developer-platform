import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { purgeExpiredRetentionRows, RETENTION_DAYS } from "./purge-retention";

const NOW = new Date("2026-08-13T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function seedNotification(id: string, createdAt: string, readAt: string | null) {
  await getDb(env)
    .prepare(
      `INSERT INTO notifications (id, organization_id, user_id, type, title, dedupe_key, read_at, created_at)
       VALUES (?, ?, ?, 'member_invited', 'T', ?, ?, ?)`
    )
    .bind(id, TEST_ORG.id, TEST_USER.id, `${id}:key`, readAt, createdAt)
    .run();
}

async function seedDelivery(id: string, updatedAt: string) {
  await getDb(env)
    .prepare(
      `INSERT INTO notification_deliveries (id, organization_id, user_id, channel, recipient, dedupe_key, status, updated_at)
       VALUES (?, ?, ?, 'email', 'a@example.com', ?, 'sent', ?)`
    )
    .bind(id, TEST_ORG.id, TEST_USER.id, `${id}:key`, updatedAt)
    .run();
}

async function remainingIds(table: string): Promise<string[]> {
  const rows = await getDb(env)
    .prepare(`SELECT id FROM ${table} ORDER BY id`)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

describe("purgeExpiredRetentionRows (postgres)", () => {
  beforeEach(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    const db = getDb(env);
    for (const table of ["notification_deliveries", "notifications", "webhook_deliveries"]) {
      await db.prepare(`DELETE FROM ${table}`).run();
    }
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
  });

  it("purges by per-table windows and leaves fresh rows alone", async () => {
    // Read: expired at 90d. Unread: expired only at 180d.
    await seedNotification(
      "ntf_read_old",
      daysAgo(RETENTION_DAYS.notificationsRead + 1),
      daysAgo(100)
    );
    await seedNotification(
      "ntf_read_fresh",
      daysAgo(RETENTION_DAYS.notificationsRead - 1),
      daysAgo(10)
    );
    await seedNotification("ntf_unread_mid", daysAgo(RETENTION_DAYS.notificationsRead + 1), null);
    await seedNotification("ntf_unread_old", daysAgo(RETENTION_DAYS.notificationsUnread + 1), null);
    await seedDelivery("ndel_old", daysAgo(RETENTION_DAYS.notificationDeliveries + 1));
    await seedDelivery("ndel_fresh", daysAgo(RETENTION_DAYS.notificationDeliveries - 1));

    const result = await purgeExpiredRetentionRows(env, NOW);

    expect(result).toMatchObject({
      notificationsRead: 1,
      notificationsUnread: 1,
      notificationDeliveries: 1,
      webhookDeliveries: 0,
    });
    // An old-but-unread row inside the unread window survives (the read window does
    // not apply to it); fresh rows survive everywhere.
    expect(await remainingIds("notifications")).toEqual(["ntf_read_fresh", "ntf_unread_mid"]);
    expect(await remainingIds("notification_deliveries")).toEqual(["ndel_fresh"]);
  });

  it("is idempotent: a second run deletes nothing", async () => {
    await seedNotification("ntf_read_old", daysAgo(120), daysAgo(100));
    await purgeExpiredRetentionRows(env, NOW);
    const second = await purgeExpiredRetentionRows(env, NOW);
    expect(second).toMatchObject({
      notificationsRead: 0,
      notificationsUnread: 0,
      notificationDeliveries: 0,
      webhookDeliveries: 0,
    });
  });
});
