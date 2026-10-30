import { hashString } from "@sdp/payments/hash";
import type {
  PaymentTransferBatchStatus,
  PaymentTransferStatus,
  PaymentTransferType,
} from "@sdp/types/payments";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { z } from "zod";
import { adminAlertEmailsCron } from "@/cron/admin-alert-emails";
import { getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import type { PaymentTransferDirection } from "@/db/repositories/payments.repository";
import { app } from "@/index";
import { createSystemAuditService, type SystemAuditLogEntry } from "@/services/audit.service";
import { ALL_API_KEY_GRANTS, TEST_API_KEY, TEST_SEEDED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import { adminAlertEmail } from "./content";
import { adminAlertEmailsEnabled, deliverAdminAlerts } from "./deliver";
import {
  ADMIN_ALERT_MAX_AGE_MS,
  enqueueConfigAlerts,
  enqueueMoneyAlerts,
  MONEY_WINDOW_MS,
} from "./enqueue";

const ORGANIZATION_ID = TEST_SEEDED_API_KEY.organizationId;
const PRODUCTION_PROJECT = `prj_${ORGANIZATION_ID}_production`;
const SANDBOX_PROJECT = `prj_${ORGANIZATION_ID}_sandbox`;
/** An admin who is not a member of the production project. */
const OTHER_ADMIN = { id: "usr_alert_other_admin", email: "other-admin@example.com" };
const MEMBER = { id: "usr_alert_member", email: "member@example.com" };
const ITERABLE_SEND_URL = "https://api.iterable.com/api/email/target";
const DASHBOARD = "https://dashboard.example.com";

let adminToken: string;
let iterable: MockInstance<typeof fetch>;

const sentEmailSchema = z.object({
  recipientEmail: z.string(),
  dataFields: z.object({ subject: z.string(), body: z.string(), bodyHtml: z.string() }).loose(),
});

function sentEmails() {
  return iterable.mock.calls
    .filter(([url]) => String(url) === ITERABLE_SEND_URL)
    .map(([, init]) => {
      const sent = sentEmailSchema.parse(JSON.parse(String(init?.body)));
      return { to: sent.recipientEmail, ...sent.dataFields };
    });
}

function asWorker<T>(fn: () => Promise<T>): Promise<T> {
  return runWithSystemDatabaseIdentity("admin-alert-emails", fn);
}

/** One Worker run, as the cron does it. */
async function runWorker(now = new Date()) {
  return asWorker(async () => {
    await enqueueConfigAlerts(env, now);
    await enqueueMoneyAlerts(env, now);
    return deliverAdminAlerts(env, now);
  });
}

function audit(entry: Omit<SystemAuditLogEntry, "organizationId">) {
  return asWorker(() =>
    createSystemAuditService(env).logSystem({ organizationId: ORGANIZATION_ID, ...entry })
  );
}

async function seedOrganization(): Promise<void> {
  const db = getDb(env);
  await db
    .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
    .bind(ORGANIZATION_ID, "Acme Pay", TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
    .run();
  for (const [user, role, name] of [
    [{ id: TEST_USER.id, email: TEST_USER.email }, "admin", "Ada Admin"],
    [OTHER_ADMIN, "admin", null],
    [MEMBER, "member", "Max Member"],
  ] as const) {
    await db
      .prepare("INSERT INTO users (id, email, name, status) VALUES (?, ?, ?, 'active')")
      .bind(user.id, user.email, name)
      .run();
    await db
      .prepare(
        "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, ?, 'active')"
      )
      .bind(`mem_${user.id}`, ORGANIZATION_ID, user.id, role)
      .run();
  }
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: TEST_USER.id,
    members: [TEST_USER.id, MEMBER.id],
    productionEntitled: true,
  });
  await seedApiKeyRow(env, await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER), {
    ...TEST_SEEDED_API_KEY,
    grants: ALL_API_KEY_GRANTS,
  });
  adminToken = await signSeededClerkMember(env, db, TEST_USER.id, ORGANIZATION_ID);
}

/** Puts both cursors where this test's history starts. */
async function resetCursors(moneyFrom: number): Promise<void> {
  await asWorker(async () => {
    const db = getDb(env);
    await db.execute("UPDATE admin_alert_cursors SET position = 0 WHERE source = 'audit_ledger'");
    await db.execute("UPDATE admin_alert_cursors SET position = ? WHERE source = 'money'", [
      moneyFrom,
    ]);
  });
}

async function insertTransfer(input: {
  id: string;
  projectId: string;
  createdAt: string;
  type?: PaymentTransferType;
  direction?: PaymentTransferDirection;
  status?: PaymentTransferStatus;
}) {
  await asWorker(() =>
    getDb(env).execute(
      `INSERT INTO payment_transfers (id, organization_id, project_id, wallet_id, source_address,
         destination_address, token, amount, type, direction, status, created_at, updated_at)
       VALUES (?, ?, ?, 'wal_1', 'src', 'dst', 'USDC', '1000000', ?, ?, ?, ?, ?)`,
      [
        input.id,
        ORGANIZATION_ID,
        input.projectId,
        input.type ?? "transfer",
        input.direction ?? "outbound",
        input.status ?? "processing",
        input.createdAt,
        input.createdAt,
      ]
    )
  );
}

async function insertBatch(
  id: string,
  projectId: string,
  createdAt: string,
  status: PaymentTransferBatchStatus = "processing"
) {
  await asWorker(() =>
    getDb(env).execute(
      `INSERT INTO payment_transfer_batches (id, organization_id, project_id, source_wallet_id,
         source_address, token, status, recipient_count, created_at, updated_at)
       VALUES (?, ?, ?, 'cwlt_1', 'src', 'USDC', ?, 250, ?, ?)`,
      [id, ORGANIZATION_ID, projectId, status, createdAt, createdAt]
    )
  );
}

/** A recurring collection's attempt, which marks its transfer as a collection. */
async function insertCollectionAttempt(transferId: string, projectId: string, createdAt: string) {
  await asWorker(async () => {
    const db = getDb(env);
    await db.execute(
      `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
       VALUES ('cp_alert', ?, ?, 'individual', 'Subscriber')`,
      [ORGANIZATION_ID, projectId]
    );
    await db.execute(
      `INSERT INTO payment_subscription_plans (id, organization_id, project_id, owner_wallet_id,
         owner_address, token, amount, period_hours, program_plan_id, status)
       VALUES ('pplan_alert', ?, ?, 'cwlt_1', 'owner', 'USDC', '1000000', 720, 'plan', 'active')`,
      [ORGANIZATION_ID, projectId]
    );
    await db.execute(
      `INSERT INTO payment_subscriptions (id, organization_id, project_id, plan_id, counterparty_id,
         subscriber_address, status)
       VALUES ('psub_alert', ?, ?, 'pplan_alert', 'cp_alert', 'subscriber', 'active')`,
      [ORGANIZATION_ID, projectId]
    );
    await db.execute(
      `INSERT INTO payment_subscription_collection_attempts (id, organization_id, project_id,
         subscription_id, transfer_id, token, amount, due_at, status, metadata, created_at, updated_at)
       VALUES ('psca_alert', ?, ?, 'psub_alert', ?, 'USDC', '1000000', ?, 'processing',
         '{"source":"manual","recurringPaymentId":"prp_alert","initiatedByKeyId":null}'::jsonb, ?, ?)`,
      [ORGANIZATION_ID, projectId, transferId, createdAt, createdAt, createdAt]
    );
  });
}

/** One audit entry per configuration event, as its writer records it, and the subject it emails. */
const CONFIG_EVENTS: [string, Omit<SystemAuditLogEntry, "organizationId">, string][] = [
  [
    "an invitation",
    {
      action: "invite",
      resourceType: "invitation",
      metadata: { email: "x@y.z", role: "admin" },
    },
    "Member invited in Acme Pay",
  ],
  [
    "a role change",
    {
      action: "update",
      resourceType: "member",
      resourceId: `mem_${MEMBER.id}`,
      metadata: { userId: MEMBER.id, previousRole: "member", role: "admin" },
    },
    "Member role changed in Acme Pay",
  ],
  [
    "a removal",
    {
      action: "delete",
      resourceType: "member",
      resourceId: `mem_${MEMBER.id}`,
      metadata: { userId: MEMBER.id, left: false },
    },
    "Member removed in Acme Pay",
  ],
  [
    "a mainnet entitlement change",
    {
      action: "update",
      resourceType: "organization",
      resourceId: ORGANIZATION_ID,
      metadata: { event: "production_entitlement_changed", enabled: false, source: "clerk" },
    },
    "Mainnet disabled in Acme Pay",
  ],
  [
    "a custody connection completed",
    {
      action: "check",
      resourceType: "custody_connection",
      resourceId: "cconn_alert",
      metadata: {
        event: "provider_credential_installation_completed",
        provider: "fireblocks",
        projectId: PRODUCTION_PROJECT,
        auditPhase: "outcome",
        auditIntentId: "aint_1",
      },
    },
    "Custody connected in Acme Pay",
  ],
  [
    "a custody connection deactivated",
    {
      action: "deactivate",
      resourceType: "custody_connection",
      resourceId: "cconn_alert",
      metadata: {
        event: "custody_connection_deactivated",
        provider: "fireblocks",
        projectId: PRODUCTION_PROJECT,
        auditPhase: "outcome",
        auditIntentId: "aint_2",
      },
    },
    "Custody disconnected in Acme Pay",
  ],
  [
    "a custody wallet created",
    {
      action: "create",
      resourceType: "custody_wallet",
      resourceId: "cwlt_alert",
      metadata: {
        event: "custody_wallet_created",
        projectId: PRODUCTION_PROJECT,
        provider: "fireblocks",
        result: "created",
        auditPhase: "outcome",
        auditIntentId: "aint_3",
      },
    },
    "Wallet created in Acme Pay",
  ],
];

describe("admin alert emails (HOO-2299)", () => {
  // A window well in the past, aligned to the digest's windows.
  const windowStart =
    Math.floor(Date.parse("2026-10-30T10:00:00.000Z") / MONEY_WINDOW_MS) * MONEY_WINDOW_MS;
  const inWindow = new Date(windowStart + 10_000).toISOString();
  const afterWindow = new Date(windowStart + MONEY_WINDOW_MS + 5 * 60_000);

  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedOrganization();
    await resetCursors(windowStart);
    env.ITERABLE_API_URL = "https://api.iterable.com";
    env.ITERABLE_API_KEY = "0123456789abcdef0123456789abcdef";
    env.ITERABLE_TRANSACTIONAL_CAMPAIGN_ID = "4242";
    env.FRONTEND_URL = DASHBOARD;
    const realFetch = globalThis.fetch;
    iterable = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) =>
        String(input) === ITERABLE_SEND_URL
          ? Response.json({ msg: "", code: "Success", params: null })
          : realFetch(input, init)
      );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    env.ITERABLE_API_URL = undefined;
    env.ITERABLE_API_KEY = undefined;
    env.ITERABLE_TRANSACTIONAL_CAMPAIGN_ID = undefined;
    await clearKVStores(env);
  });

  describe("configuration changes email every organization admin", () => {
    it("emails each admin once when a project API key is created", async () => {
      const response = await app.request(
        `/v1/projects/${PRODUCTION_PROJECT}/api-keys`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "ci-deployer",
            grants: ["projects.read"],
            walletScope: "all",
          }),
        },
        env
      );
      expect(response.status).toBe(201);

      await runWorker();
      const emails = sentEmails();
      expect(emails.map((email) => email.to).sort()).toEqual(
        [OTHER_ADMIN.email, TEST_USER.email].sort()
      );
      expect(emails[0]?.subject).toBe("API key created in Acme Pay");
      expect(emails[0]?.body).toContain("A new API key, ci-deployer, was created.");
      expect(emails[0]?.body).toContain("Network: Mainnet");
      expect(emails[0]?.body).toContain("By: Ada Admin");
      expect(emails[0]?.body).toMatch(/When: \d{1,2} \w{3} \d{4}, \d{2}:\d{2} UTC/);
      expect(emails[0]?.body).toContain(`${DASHBOARD}/dashboard/${PRODUCTION_PROJECT}/api-keys`);
      expect(emails[0]?.body).not.toMatch(/sk_|secret/i);
      expect(emails[0]?.bodyHtml).toContain(
        `href="${DASHBOARD}/dashboard/${PRODUCTION_PROJECT}/api-keys"`
      );
    });

    it("emails each admin once when a mainnet API key is revoked", async () => {
      const created = await app.request(
        `/v1/projects/${PRODUCTION_PROJECT}/api-keys`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "leaked", grants: ["projects.read"], walletScope: "all" }),
        },
        env
      );
      expect(created.status).toBe(201);
      const keyId = z
        .object({ data: z.object({ apiKey: z.object({ id: z.string() }) }) })
        .parse(await created.json()).data.apiKey.id;
      await runWorker();
      iterable.mockClear();

      const revoked = await app.request(
        `/v1/api-keys/${keyId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
            "x-project-id": PRODUCTION_PROJECT,
          },
          body: JSON.stringify({ confirmation: "leaked" }),
        },
        env
      );
      expect(revoked.status).toBe(200);
      await runWorker();
      const emails = sentEmails();
      expect(emails.map((email) => email.subject)).toEqual([
        "API key revoked in Acme Pay",
        "API key revoked in Acme Pay",
      ]);
      expect(emails[0]?.body).toContain("Project: ");
    });

    it("sends nothing for an API key created in a devnet project", async () => {
      const response = await app.request(
        `/v1/projects/${SANDBOX_PROJECT}/api-keys`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "dev-key", grants: ["projects.read"], walletScope: "all" }),
        },
        env
      );
      expect(response.status).toBe(201);
      await runWorker();
      expect(sentEmails()).toHaveLength(0);
    });

    it.each(CONFIG_EVENTS)("emails each admin once for %s", async (_, entry, subject) => {
      await audit({ ...entry, status: "success" });
      await runWorker();
      const emails = sentEmails();
      expect(emails).toHaveLength(2);
      expect(new Set(emails.map((email) => email.subject))).toEqual(new Set([subject]));
    });

    it("names the member a role change is about", async () => {
      await audit({
        action: "update",
        resourceType: "member",
        metadata: { userId: MEMBER.id, previousRole: "member", role: "admin" },
      });
      await runWorker();
      const [email] = sentEmails();
      expect(email?.body).toContain("Max Member (member@example.com) is now admin in Acme Pay.");
      expect(email?.body).toContain("Role: Member to Admin");
    });

    it("ignores a custody intent, a started event, and a replayed wallet outcome", async () => {
      await audit({
        action: "deactivate",
        resourceType: "custody_connection",
        metadata: {
          event: "custody_connection_deactivation_started",
          projectId: PRODUCTION_PROJECT,
        },
      });
      await audit({
        action: "create",
        resourceType: "custody_wallet",
        metadata: {
          event: "custody_wallet_created",
          projectId: PRODUCTION_PROJECT,
          result: "already_recorded",
          auditPhase: "outcome",
        },
      });
      await runWorker();
      expect(sentEmails()).toHaveLength(0);
    });

    it("ignores a failed entry, an audit intent, and entries no alert covers", async () => {
      await audit({ action: "invite", resourceType: "invitation", status: "failure" });
      await audit({ action: "read", resourceType: "organization" });
      await audit({ action: "update", resourceType: "api_key", metadata: { name: "renamed" } });
      await audit({
        action: "maintenance",
        resourceType: "audit_ledger",
        metadata: { auditPhase: "intent", target: { action: "create" } },
      });
      await runWorker();
      expect(sentEmails()).toHaveLength(0);
    });

    it("escapes customer-supplied names in the HTML part and keeps the line breaks", async () => {
      await asWorker(() =>
        getDb(env).execute("UPDATE organizations SET name = ? WHERE id = ?", [
          "Acme <b>Pay</b> & Co",
          ORGANIZATION_ID,
        ])
      );
      await audit({ action: "invite", resourceType: "invitation", metadata: { role: "member" } });
      await runWorker();
      const [email] = sentEmails();
      expect(email?.body).toContain("Organization: Acme <b>Pay</b> & Co");
      expect(email?.bodyHtml).toContain("Acme &lt;b&gt;Pay&lt;/b&gt; &amp; Co</td>");
      expect(email?.bodyHtml).not.toContain("<b>");
    });

    it("does not send a queued alert once alert emails are turned off", async () => {
      await audit({ action: "invite", resourceType: "invitation", metadata: { role: "member" } });
      await asWorker(() => enqueueConfigAlerts(env));
      await asWorker(() =>
        getDb(env).execute("UPDATE organizations SET settings = ? WHERE id = ?", [
          JSON.stringify({ enableProductionProject: true, alertEmails: false }),
          ORGANIZATION_ID,
        ])
      );
      expect(await asWorker(() => deliverAdminAlerts(env))).toMatchObject({
        sent: 0,
        suppressed: 2,
      });
      expect(sentEmails()).toHaveLength(0);
    });

    it("does not send a queued alert to someone who is no longer an admin", async () => {
      await audit({ action: "invite", resourceType: "invitation", metadata: { role: "member" } });
      await asWorker(() => enqueueConfigAlerts(env));
      await asWorker(() =>
        getDb(env).execute(
          "UPDATE organization_members SET role = 'member' WHERE organization_id = ? AND user_id = ?",
          [ORGANIZATION_ID, OTHER_ADMIN.id]
        )
      );
      expect(await asWorker(() => deliverAdminAlerts(env))).toMatchObject({
        sent: 1,
        suppressed: 1,
      });
      expect(sentEmails().map((email) => email.to)).toEqual([TEST_USER.email]);
    });

    it("does not email an admin twice when a run repeats", async () => {
      await audit({ action: "invite", resourceType: "invitation", metadata: { role: "member" } });
      await runWorker();
      await runWorker();
      await asWorker(() => deliverAdminAlerts(env, new Date(Date.now() + 2 * 60 * 60_000)));
      expect(sentEmails()).toHaveLength(2);
    });

    it("retries only the failed delivery, and sends it once", async () => {
      await audit({ action: "invite", resourceType: "invitation", metadata: { role: "member" } });
      iterable.mockImplementation(async (_input, init) => {
        const to = sentEmailSchema.parse(JSON.parse(String(init?.body))).recipientEmail;
        return to === OTHER_ADMIN.email
          ? new Response("down", { status: 500 })
          : Response.json({ msg: "", code: "Success", params: null });
      });
      const first = await runWorker();
      expect(first).toMatchObject({ sent: 1, failed: 1 });

      iterable.mockImplementation(async () =>
        Response.json({ msg: "", code: "Success", params: null })
      );
      // Before the backoff ends nothing is due; after it, only the failed one.
      expect(await runWorker()).toMatchObject({ sent: 0, failed: 0 });
      const later = await runWorker(new Date(Date.now() + 2 * 60_000));
      expect(later).toMatchObject({ sent: 1, failed: 0 });
      expect(
        sentEmails()
          .map((email) => email.to)
          .sort()
      ).toEqual([TEST_USER.email, OTHER_ADMIN.email, OTHER_ADMIN.email].sort());
      expect(await runWorker(new Date(Date.now() + 3 * 60 * 60_000))).toMatchObject({ sent: 0 });
    });

    it("emails admins when alert emails are turned off, and nothing after", async () => {
      const response = await app.request(
        `/v1/organizations/${ORGANIZATION_ID}`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ settings: { alertEmails: false } }),
        },
        env
      );
      expect(response.status).toBe(200);
      expect((await response.json()).data.settings).toMatchObject({ alertEmails: false });
      await audit({ action: "invite", resourceType: "invitation", metadata: { role: "admin" } });
      await runWorker();
      expect(sentEmails().map((email) => email.subject)).toEqual([
        "Alert emails off in Acme Pay",
        "Alert emails off in Acme Pay",
      ]);
    });

    it("leaves alert emails on when turning them off cannot be audited", async () => {
      const constraint = "sdp_test_fail_organization_audit";
      await getDb(env).execute(
        `ALTER TABLE audit_logs ADD CONSTRAINT ${constraint}
           CHECK (resource_type IS DISTINCT FROM 'organization') NOT VALID`
      );
      try {
        const response = await app.request(
          `/v1/organizations/${ORGANIZATION_ID}`,
          {
            method: "PATCH",
            headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ settings: { alertEmails: false } }),
          },
          env
        );
        expect(response.status).toBe(500);
      } finally {
        await getDb(env).execute(`ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS ${constraint}`);
      }
      const stored = await asWorker(() =>
        getDb(env).queryOne<{ alert_emails: string | null }>(
          "SELECT settings::jsonb ->> 'alertEmails' AS alert_emails FROM organizations WHERE id = ?",
          [ORGANIZATION_ID]
        )
      );
      expect(stored?.alert_emails ?? null).toBeNull();
    });

    it("refuses an API key changing the alert email setting", async () => {
      const response = await app.request(
        `/v1/organizations/${ORGANIZATION_ID}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ settings: { alertEmails: false } }),
        },
        env
      );
      expect(response.status).toBe(403);
    });
  });

  describe("money movement emails every organization admin, one digest per window", () => {
    it("sends one email per admin for transfers, a batch, a collection and a deposit", async () => {
      await insertTransfer({ id: "ptx_1", projectId: PRODUCTION_PROJECT, createdAt: inWindow });
      await insertTransfer({ id: "ptx_2", projectId: PRODUCTION_PROJECT, createdAt: inWindow });
      await insertBatch("pbat_1", PRODUCTION_PROJECT, inWindow);
      // A batch's chunk transfers count as its one batch, not as transfers.
      await insertTransfer({
        id: "ptx_chunk",
        projectId: PRODUCTION_PROJECT,
        createdAt: inWindow,
        type: "transfer_batch",
      });
      await insertTransfer({
        id: "ptx_recurring",
        projectId: PRODUCTION_PROJECT,
        createdAt: inWindow,
      });
      await insertCollectionAttempt("ptx_recurring", PRODUCTION_PROJECT, inWindow);
      await insertTransfer({
        id: "ptx_in",
        projectId: PRODUCTION_PROJECT,
        createdAt: inWindow,
        direction: "inbound",
      });

      const result = await runWorker(afterWindow);
      expect(result.sent).toBe(2);
      const emails = sentEmails();
      // Every admin, whether or not a member of the project; the member gets none.
      expect(emails.map((email) => email.to).sort()).toEqual(
        [OTHER_ADMIN.email, TEST_USER.email].sort()
      );
      const [email] = emails;
      expect(email?.subject).toBe("Money movement in Acme Pay");
      for (const row of [
        "Network: Mainnet",
        "Transfers: 2",
        "Batch payouts: 1",
        "Recurring collections: 1",
        "Deposits: 1",
      ]) {
        expect(email?.body).toContain(row);
      }
      expect(email?.body).toContain(
        `${DASHBOARD}/dashboard/${PRODUCTION_PROJECT}/payments/transactions`
      );
      expect(email?.body).not.toContain("1000000");
      expect(email?.body).not.toContain("dst");
    });

    it("does not count a payment that failed before reaching the chain", async () => {
      await insertTransfer({
        id: "ptx_failed",
        projectId: PRODUCTION_PROJECT,
        createdAt: inWindow,
        status: "failed",
      });
      await insertBatch("pbat_failed", PRODUCTION_PROJECT, inWindow, "failed");
      await runWorker(afterWindow);
      expect(sentEmails()).toHaveLength(0);
    });

    it("writes the digest once, however many runs follow", async () => {
      await insertTransfer({ id: "ptx_1", projectId: PRODUCTION_PROJECT, createdAt: inWindow });
      await runWorker(afterWindow);
      await runWorker(afterWindow);
      await runWorker(new Date(afterWindow.getTime() + 60 * 60_000));
      expect(sentEmails()).toHaveLength(2);
    });

    it("waits for the window to close before writing it", async () => {
      await insertTransfer({ id: "ptx_1", projectId: PRODUCTION_PROJECT, createdAt: inWindow });
      expect(await runWorker(new Date(windowStart + MONEY_WINDOW_MS))).toMatchObject({ sent: 0 });
      expect(sentEmails()).toHaveLength(0);
    });

    it("sends nothing for a devnet project", async () => {
      await insertTransfer({ id: "ptx_1", projectId: SANDBOX_PROJECT, createdAt: inWindow });
      await runWorker(afterWindow);
      expect(sentEmails()).toHaveLength(0);
    });

    it("sends nothing once the organization turned alert emails off", async () => {
      await asWorker(() =>
        getDb(env).execute("UPDATE organizations SET settings = ? WHERE id = ?", [
          JSON.stringify({ enableProductionProject: true, alertEmails: false }),
          ORGANIZATION_ID,
        ])
      );
      await insertTransfer({ id: "ptx_1", projectId: PRODUCTION_PROJECT, createdAt: inWindow });
      await insertBatch("pbat_1", PRODUCTION_PROJECT, inWindow);
      await audit({ action: "invite", resourceType: "invitation", metadata: { role: "admin" } });
      await runWorker(afterWindow);
      expect(sentEmails()).toHaveLength(0);
    });
  });

  describe("where email is not configured (dev, stage)", () => {
    it.each([
      ["no Iterable key", { ITERABLE_API_KEY: undefined }],
      ["a placeholder Iterable key", { ITERABLE_API_KEY: "placeholder" }],
      ["a placeholder campaign id", { ITERABLE_TRANSACTIONAL_CAMPAIGN_ID: "placeholder" }],
      ["a placeholder Iterable URL", { ITERABLE_API_URL: "placeholder" }],
      ["no dashboard URL", { FRONTEND_URL: undefined }],
      ["a placeholder dashboard URL", { FRONTEND_URL: "placeholder" }],
      ["an http dashboard URL to another host", { FRONTEND_URL: "http://dashboard.example.com" }],
    ] as const)("does not register the cron with %s", (_, overrides) => {
      const configured = { ...env, ...overrides };
      expect(adminAlertEmailsEnabled(configured)).toBe(false);
      expect(adminAlertEmailsCron.enabled(configured)).toBe(false);
    });

    it("registers it where Iterable and the dashboard are both configured", () => {
      expect(adminAlertEmailsCron.enabled(env)).toBe(true);
    });

    it("registers it with a local dashboard over http", () => {
      expect(adminAlertEmailsCron.enabled({ ...env, FRONTEND_URL: "http://localhost:3000" })).toBe(
        true
      );
    });

    it("summarizes at most a day of money when email is turned on long after", async () => {
      const now = new Date(windowStart + 30 * 24 * 60 * 60_000);
      await insertTransfer({
        id: "ptx_old",
        projectId: PRODUCTION_PROJECT,
        createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60_000).toISOString(),
      });
      await insertTransfer({
        id: "ptx_recent",
        projectId: PRODUCTION_PROJECT,
        createdAt: new Date(now.getTime() - ADMIN_ALERT_MAX_AGE_MS / 2).toISOString(),
      });
      // Delivery runs on the real clock, which dated the delivery rows.
      await asWorker(() => enqueueMoneyAlerts(env, now));
      await asWorker(() => deliverAdminAlerts(env));
      const emails = sentEmails();
      expect(emails).toHaveLength(2);
      expect(emails[0]?.body).toContain("Transfers: 1\nStarted:");
    });
  });

  it("refuses to render a money alert without its counts and window", () => {
    expect(() =>
      adminAlertEmail({
        kind: "money_movement",
        details: { organizationName: "Acme", project: null, actor: null, subject: null },
        occurredAt: "2026-10-30T10:15:00.000Z",
        dashboardOrigin: DASHBOARD,
      })
    ).toThrow();
  });

  it("renders no field it was not given", () => {
    const email = adminAlertEmail({
      kind: "money_movement",
      details: {
        organizationName: "Acme",
        project: { id: "prj_1", name: "Treasury", environment: "production" },
        actor: null,
        subject: null,
        counts: {
          transfers: 1,
          batches: 0,
          recurringCollections: 2,
          paymentRequestSettlements: 0,
          deposits: 0,
          offramps: 0,
          onramps: 0,
        },
        windowStart: "2026-10-30T10:00:00.000Z",
        windowEnd: "2026-10-30T10:15:00.000Z",
      },
      occurredAt: "2026-10-30T10:15:00.000Z",
      dashboardOrigin: DASHBOARD,
    });
    expect(email.subject).toBe("Money movement in Acme");
    expect(email.content.summary).toBe("New money movement started in Treasury.");
    expect(email.content.details).toEqual([
      { label: "Organization", value: "Acme" },
      { label: "Project", value: "Treasury" },
      { label: "Network", value: "Mainnet" },
      { label: "Transfers", value: "1" },
      { label: "Recurring collections", value: "2" },
      { label: "Started", value: "30 Oct 2026, 10:00 to 10:15 UTC" },
    ]);
    expect(email.content.action?.url).toBe(`${DASHBOARD}/dashboard/prj_1/payments/transactions`);
  });
});
