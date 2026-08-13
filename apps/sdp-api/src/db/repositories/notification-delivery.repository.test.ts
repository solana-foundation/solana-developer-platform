import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { NotificationDeliveriesRepository } from "./notification-delivery.repository";
import { createPostgresNotificationDeliveriesRepository } from "./notification-delivery.repository.postgres";

const CLAIM = {
  organizationId: TEST_ORG.id,
  userId: TEST_USER.id,
  channel: "email" as const,
  recipient: "admin@example.com",
  dedupeKey: "evt_1:usr_1",
};

describe("NotificationDeliveriesRepository (postgres)", () => {
  let repo: NotificationDeliveriesRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM notification_deliveries").run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    repo = createPostgresNotificationDeliveriesRepository(db);
  });

  async function readStatus(id: string) {
    return getDb(env)
      .prepare("SELECT status, attempt_count, recipient FROM notification_deliveries WHERE id = ?")
      .bind(id)
      .first<{ status: string; attempt_count: number; recipient: string }>();
  }

  it("claims a fresh key and refuses a second claim while pending", async () => {
    const first = await repo.claim(CLAIM);
    expect(first).toBeTruthy();
    // In flight ('pending') — a concurrent retry must not send a second email.
    expect(await repo.claim(CLAIM)).toBeNull();
  });

  it("never reclaims a sent delivery", async () => {
    const id = await repo.claim(CLAIM);
    if (!id) throw new Error("expected claim");
    await repo.markSent({ id, providerMessageId: "msg_123" });
    expect(await repo.claim(CLAIM)).toBeNull();
    expect((await readStatus(id))?.status).toBe("sent");
  });

  it("reclaims a failed delivery, bumping attempt_count and taking the new recipient", async () => {
    const id = await repo.claim(CLAIM);
    if (!id) throw new Error("expected claim");
    await repo.markFailed({ id, error: "provider 500" });

    // A corrected address on the same idempotency key wins on reclaim.
    const reclaimed = await repo.claim({ ...CLAIM, recipient: "corrected@example.com" });
    expect(reclaimed).toBe(id);
    const row = await readStatus(id);
    expect(row?.status).toBe("pending");
    expect(row?.attempt_count).toBe(2);
    expect(row?.recipient).toBe("corrected@example.com");
  });

  it("scopes idempotency to (channel, dedupeKey), not recipient", async () => {
    expect(await repo.claim(CLAIM)).toBeTruthy();
    expect(await repo.claim({ ...CLAIM, dedupeKey: "evt_2:usr_1" })).toBeTruthy();
  });
});
