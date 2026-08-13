import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  createNotificationPreferencesRepository,
  createSystemCounterpartiesRepository,
} from "@/db/repositories";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { dispatchCounterpartyEmail, dispatchNotification } from "./dispatcher";

const { sendMock, emailConfiguredMock, publishMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  emailConfiguredMock: vi.fn(() => true),
  publishMock: vi.fn(
    async (
      _env: unknown,
      _orgId: string,
      _userId: string,
      _nudge: { unread: number; ts: string }
    ) => {}
  ),
}));

vi.mock("@/services/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/email")>();
  return {
    ...actual,
    isEmailConfigured: emailConfiguredMock,
    createTransactionalEmailService: () => ({ send: sendMock }),
  };
});

vi.mock("@/runtime/pubsub-redis", () => ({
  publishInboxNudge: publishMock,
  subscribeInbox: vi.fn(),
  closeAllSubscribers: vi.fn(),
}));

const ADMIN_2 = { id: "usr_dispatch_admin2", email: "admin2@example.com" };
const MEMBER = { id: "usr_dispatch_member", email: "member@example.com" };
const PROJECT_ID = "prj_dispatcher_test";

describe("dispatchNotification (postgres)", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    sendMock.mockReset().mockResolvedValue({ messageId: "msg_1", acceptedAt: "now" });
    emailConfiguredMock.mockReset().mockReturnValue(true);
    publishMock.mockReset().mockResolvedValue(undefined);

    const db = getDb(env);
    for (const table of [
      "notification_deliveries",
      "notification_preferences",
      "notifications",
      "counterparties",
      "organization_members",
      "projects",
    ]) {
      await db.prepare(`DELETE FROM ${table}`).run();
    }
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    for (const [id, email] of [
      [TEST_USER.id, TEST_USER.email],
      [ADMIN_2.id, ADMIN_2.email],
      [MEMBER.id, MEMBER.email],
    ]) {
      await db
        .prepare(
          "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
        )
        .bind(id, email)
        .run();
    }
    for (const [userId, role] of [
      [TEST_USER.id, "admin"],
      [ADMIN_2.id, "org:admin"], // legacy Clerk-style role must still resolve
      [MEMBER.id, "member"],
    ]) {
      await db
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES (?, ?, ?, ?, 'active')`
        )
        .bind(`om_${userId}`, TEST_ORG.id, userId, role)
        .run();
    }
  });

  function baseInput(eventKey = "evt_test_1") {
    return {
      organizationId: TEST_ORG.id,
      type: "member_invited" as const,
      eventKey,
      title: "Member invited",
      body: "someone@example.com was invited.",
    };
  }

  async function notificationCount(): Promise<number> {
    const row = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS n FROM notifications WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("fans out to admins with in-app rows, emails, and one nudge per recipient", async () => {
    const result = await dispatchNotification(env, baseInput());
    expect(result).toEqual({ resolved: 2, inserted: 2, emailed: 2 });
    expect(await notificationCount()).toBe(2);
    // Per-recipient sends — addresses never share a `to:` line.
    expect(sendMock).toHaveBeenCalledTimes(2);
    for (const call of sendMock.mock.calls) {
      expect(call[0].to).toHaveLength(1);
      expect(call[0].html).toContain("Member invited");
      expect(call[0].text).toContain("Member invited");
    }
    // One nudge per recipient with that user's own unread count.
    expect(publishMock).toHaveBeenCalledTimes(2);
    for (const [, orgId, , nudge] of publishMock.mock.calls) {
      expect(orgId).toBe(TEST_ORG.id);
      expect(nudge?.unread).toBe(1);
    }
  });

  it("excludes the actor from their own event", async () => {
    const result = await dispatchNotification(env, {
      ...baseInput(),
      excludeUserIds: [TEST_USER.id],
    });
    expect(result.resolved).toBe(1);
    const rows = await getDb(env)
      .prepare("SELECT user_id FROM notifications WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .all<{ user_id: string }>();
    expect(rows.results.map((r) => r.user_id)).toEqual([ADMIN_2.id]);
  });

  it("applies per-channel preferences independently", async () => {
    const preferences = createNotificationPreferencesRepository(env);
    // TEST_USER mutes in-app for members; ADMIN_2 mutes email for members.
    await preferences.upsertMany({
      organizationId: TEST_ORG.id,
      userId: TEST_USER.id,
      entries: [{ category: "members", channel: "in_app", enabled: false }],
    });
    await preferences.upsertMany({
      organizationId: TEST_ORG.id,
      userId: ADMIN_2.id,
      entries: [{ category: "members", channel: "email", enabled: false }],
    });

    const result = await dispatchNotification(env, baseInput());
    expect(result.resolved).toBe(2);
    expect(result.inserted).toBe(1);
    expect(result.emailed).toBe(1);

    const rows = await getDb(env)
      .prepare("SELECT user_id FROM notifications WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .all<{ user_id: string }>();
    expect(rows.results.map((r) => r.user_id)).toEqual([ADMIN_2.id]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0].to).toEqual([TEST_USER.email]);
  });

  it("is idempotent on eventKey: a retried producer sends nothing and nudges nobody", async () => {
    await dispatchNotification(env, baseInput());
    sendMock.mockClear();
    publishMock.mockClear();

    const retry = await dispatchNotification(env, baseInput());
    expect(retry).toEqual({ resolved: 2, inserted: 0, emailed: 0 });
    expect(await notificationCount()).toBe(2);
    expect(sendMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("a failed email is retryable on the next dispatch; a sent one is not", async () => {
    sendMock.mockRejectedValue(new Error("provider 500"));
    const first = await dispatchNotification(env, baseInput());
    expect(first.emailed).toBe(0);
    // In-app rows landed regardless — email failures never reject the dispatch.
    expect(first.inserted).toBe(2);

    sendMock.mockReset().mockResolvedValue({ messageId: "msg_2", acceptedAt: "now" });
    const second = await dispatchNotification(env, baseInput());
    // Failed claims are reclaimed and re-sent; in-app rows stay deduped.
    expect(second.emailed).toBe(2);
    expect(second.inserted).toBe(0);

    const deliveries = await getDb(env)
      .prepare(
        "SELECT status, attempt_count FROM notification_deliveries WHERE organization_id = ?"
      )
      .bind(TEST_ORG.id)
      .all<{ status: string; attempt_count: number }>();
    expect(deliveries.results).toHaveLength(2);
    for (const row of deliveries.results) {
      expect(row.status).toBe("sent");
      expect(row.attempt_count).toBe(2);
    }
  });

  it("resolves explicit userIds only against active org members", async () => {
    const result = await dispatchNotification(env, {
      ...baseInput(),
      userIds: [MEMBER.id, "usr_not_a_member"],
    });
    expect(result.resolved).toBe(1);
    const rows = await getDb(env)
      .prepare("SELECT user_id FROM notifications WHERE organization_id = ?")
      .bind(TEST_ORG.id)
      .all<{ user_id: string }>();
    expect(rows.results.map((r) => r.user_id)).toEqual([MEMBER.id]);
  });

  it("skips email entirely when the channel is unconfigured", async () => {
    emailConfiguredMock.mockReturnValue(false);
    const result = await dispatchNotification(env, baseInput());
    expect(result).toEqual({ resolved: 2, inserted: 2, emailed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("dispatchCounterpartyEmail (postgres)", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  let counterpartyId: string;

  beforeEach(async () => {
    sendMock.mockReset().mockResolvedValue({ messageId: "msg_cp", acceptedAt: "now" });
    emailConfiguredMock.mockReset().mockReturnValue(true);
    publishMock.mockReset().mockResolvedValue(undefined);

    const db = getDb(env);
    for (const table of [
      "notification_deliveries",
      "notifications",
      "counterparties",
      "projects",
    ]) {
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
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', 'test-project', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, TEST_ORG.id, TEST_USER.id)
      .run();

    const counterparty = await createSystemCounterpartiesRepository(env).createCounterparty({
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      externalId: null,
      entityType: "business",
      displayName: "ACME Corp",
      email: "finance@acme.example.com",
      identity: { address: { line1: "1 Market St", city: "San Francisco", countryCode: "US" } },
      createdBy: TEST_USER.id,
    });
    if (!counterparty) throw new Error("failed to seed counterparty");
    counterpartyId = counterparty.id;
  });

  function receipt(eventKey = "payment_settled:tr_1") {
    return {
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      counterpartyId,
      type: "payment_settled" as const,
      eventKey,
      title: "Your payment has settled",
      body: "Your payout of 100 USD has settled.",
    };
  }

  it("emails the counterparty once, with the who-and-why footer, and no in-app row", async () => {
    const result = await dispatchCounterpartyEmail(env, receipt());
    expect(result).toEqual({ emailed: 1 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const message = sendMock.mock.calls[0]?.[0];
    expect(message.to).toEqual(["finance@acme.example.com"]);
    expect(message.html).toContain(TEST_ORG.name);

    const notifications = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS n FROM notifications")
      .first<{ n: number }>();
    expect(notifications?.n).toBe(0);

    // Webhook replay: the delivery claim refuses a second send.
    sendMock.mockClear();
    expect(await dispatchCounterpartyEmail(env, receipt())).toEqual({ emailed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("no-ops cleanly for a wrong org or an unknown counterparty", async () => {
    expect(
      await dispatchCounterpartyEmail(env, { ...receipt(), organizationId: "org_other" })
    ).toEqual({ emailed: 0 });
    expect(
      await dispatchCounterpartyEmail(env, { ...receipt(), counterpartyId: "cp_missing" })
    ).toEqual({ emailed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    const claims = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS n FROM notification_deliveries")
      .first<{ n: number }>();
    expect(claims?.n).toBe(0);
  });

  it("never throws when the send fails", async () => {
    sendMock.mockRejectedValue(new Error("provider down"));
    const result = await dispatchCounterpartyEmail(env, receipt());
    expect(result.emailed).toBe(0);
    expect(result.error).toContain("provider down");
  });
});
