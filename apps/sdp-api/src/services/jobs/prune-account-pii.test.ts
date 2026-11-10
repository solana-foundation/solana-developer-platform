import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { createSystemAuditService } from "@/services/audit.service";
import { pseudonymousEmail } from "@/services/data-retention-policy";
import { env } from "@/test/helpers/env";
import { seedInvitation } from "@/test/helpers/invitations";
import { organizationMember, seedOrganizationMembers } from "@/test/helpers/organization-members";
import { readRetentionEvidence, seedRetentionEvidence } from "@/test/helpers/retention";
import { seedTestDatabase } from "@/test/mocks/db";
import { pruneAccountPii } from "./prune-account-pii";

const policy = vi.hoisted(() => ({ enforce: false }));
vi.mock("@/services/data-retention-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/data-retention-policy")>();
  return {
    ...actual,
    get ACCOUNT_PII_RETENTION_ENFORCED() {
      return policy.enforce;
    },
  };
});

const ORG = { id: "org_retention", slug: "retention" };
const OWNER = organizationMember("retention_owner", "admin");

async function seedExpiredInvitation(id: string, ageDays: number) {
  const db = getDb(env);
  await seedInvitation(db, {
    id,
    organizationId: ORG.id,
    email: `${id}@example.test`,
    role: "member",
    invitedBy: OWNER.userId,
    status: "pending",
    expiresInDays: 7,
  });
  await db.execute(`UPDATE invitations SET created_at = ?, expires_at = ? WHERE id = ?`, [
    new Date(Date.now() - (ageDays + 7) * 86_400_000).toISOString(),
    new Date(Date.now() - ageDays * 86_400_000).toISOString(),
    id,
  ]);
}

describe("account PII retention", () => {
  beforeEach(async () => {
    policy.enforce = false;
    await seedTestDatabase(env);
    await seedOrganizationMembers(getDb(env), { organization: ORG, members: [OWNER] });
  });

  it("reports candidates without changing personal data before policy approval", async () => {
    await seedExpiredInvitation("inv_old", 31);
    await seedExpiredInvitation("inv_recent", 29);
    expect(await pruneAccountPii(env)).toMatchObject({ mode: "dry-run", invitations: 1 });
    expect(
      await getDb(env).queryOne(
        "SELECT email, status, pii_pseudonymized_at FROM invitations WHERE id = 'inv_old'"
      )
    ).toEqual({ email: "inv_old@example.test", status: "pending", pii_pseudonymized_at: null });
  });

  it("approved enforcement scrubs expired invitations once and preserves recent invitations and audit history", async () => {
    policy.enforce = true;
    await seedExpiredInvitation("inv_old", 31);
    await seedExpiredInvitation("inv_recent", 29);
    await createSystemAuditService(env).logSystem({
      action: "invite",
      resourceType: "invitation",
      resourceId: "inv_old",
      organizationId: ORG.id,
      metadata: { email: "inv_old@example.test" },
    });
    const auditBefore = await getDb(env).queryMany(
      "SELECT id, encode(entry_hash, 'hex') AS hash FROM audit_logs ORDER BY ledger_sequence"
    );
    expect(await pruneAccountPii(env)).toMatchObject({ mode: "enforce", invitations: 1 });
    expect(
      await getDb(env).queryOne("SELECT email, status FROM invitations WHERE id = 'inv_old'")
    ).toEqual({ email: pseudonymousEmail("inv_old"), status: "expired" });
    expect(
      await getDb(env).queryOne("SELECT email, status FROM invitations WHERE id = 'inv_recent'")
    ).toEqual({ email: "inv_recent@example.test", status: "pending" });
    expect(
      await getDb(env).queryMany(
        "SELECT id, encode(entry_hash, 'hex') AS hash FROM audit_logs ORDER BY ledger_sequence"
      )
    ).toEqual(auditBefore);
    expect(await pruneAccountPii(env)).toMatchObject({ invitations: 0 });
  });

  it("preserves invitations that account deletion already pseudonymized", async () => {
    const db = getDb(env);
    await seedExpiredInvitation("inv_already_deleted", 100);
    const email = `deleted+${OWNER.userId}@users.invalid`;
    await db.execute(
      "UPDATE invitations SET email = ?, status = 'revoked' WHERE id = 'inv_already_deleted'",
      [email]
    );
    expect(await pruneAccountPii(env)).toMatchObject({ mode: "dry-run", invitations: 0 });
    policy.enforce = true;
    expect(await pruneAccountPii(env)).toMatchObject({ invitations: 0 });
    expect(
      await db.queryOne(
        "SELECT email, status, pii_pseudonymized_at FROM invitations WHERE id = 'inv_already_deleted'"
      )
    ).toEqual({ email, status: "revoked", pii_pseudonymized_at: null });
  });

  it("overlapping workers claim each stale row once", async () => {
    policy.enforce = true;
    await seedExpiredInvitation("inv_overlap", 31);
    const results = await Promise.all([pruneAccountPii(env), pruneAccountPii(env)]);
    expect(results[0].invitations + results[1].invitations).toBe(1);
  });

  it("notification snapshots lose identifying strings without deleting delivery evidence", async () => {
    policy.enforce = true;
    const db = getDb(env);
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    await db.execute(
      `INSERT INTO admin_alerts (id, organization_id, kind, source_key, details, occurred_at, created_at)
       VALUES ('aalt_retention', ?, 'member_removed', 'retention-test', ?::jsonb, ?, ?)`,
      [
        ORG.id,
        JSON.stringify({
          organizationName: "Retention",
          project: null,
          actor: "Private Person",
          subject: OWNER.email,
        }),
        old,
        old,
      ]
    );
    await db.execute(
      `INSERT INTO admin_alert_deliveries (alert_id, organization_id, user_id, email, status, created_at)
       VALUES ('aalt_retention', ?, ?, ?, 'sent', ?)`,
      [ORG.id, OWNER.userId, OWNER.email, old]
    );
    expect(await pruneAccountPii(env)).toMatchObject({ alerts: 1, deliveries: 1 });
    expect(
      await db.queryOne(
        "SELECT details->>'actor' AS actor, details->>'subject' AS subject FROM admin_alerts WHERE id = 'aalt_retention'"
      )
    ).toEqual({ actor: null, subject: null });
    expect(
      await db.queryOne(
        "SELECT email, status FROM admin_alert_deliveries WHERE alert_id = 'aalt_retention'"
      )
    ).toEqual({ email: pseudonymousEmail(OWNER.userId), status: "sent" });
  });

  it("caps dry-run counts and enforcement batches on a large backlog", async () => {
    const db = getDb(env);
    await db.execute(
      `INSERT INTO invitations (id, organization_id, email, role, invited_by, expires_at, created_at)
       SELECT 'inv_backlog_' || n, ?, 'backlog-' || n || '@example.test', 'member', ?,
              '2020-01-02T00:00:00.000Z', '2020-01-01 00:00:00'
         FROM generate_series(1, 20001) n`,
      [ORG.id, OWNER.userId]
    );
    expect(await pruneAccountPii(env)).toMatchObject({
      mode: "dry-run",
      invitations: 20000,
      capped: true,
    });
    expect(
      await db.queryOne(
        "SELECT COUNT(*)::int AS count FROM invitations WHERE pii_pseudonymized_at IS NULL"
      )
    ).toEqual({ count: 20001 });
    policy.enforce = true;
    expect(await pruneAccountPii(env)).toMatchObject({ invitations: 20000, capped: true });
    expect(
      await db.queryOne(
        "SELECT COUNT(*)::int AS count FROM invitations WHERE pii_pseudonymized_at IS NULL"
      )
    ).toEqual({ count: 1 });
    expect(await pruneAccountPii(env)).toMatchObject({ invitations: 1, capped: false });
  });

  it("retains invitations with recent acceptance, creation, or expiry in either UTC timestamp format", async () => {
    policy.enforce = true;
    const db = getDb(env);
    const now = new Date("2026-11-09T12:00:00.000Z");
    for (const id of [
      "inv_accepted",
      "inv_created",
      "inv_expiry",
      "inv_legacy_before",
      "inv_legacy_after",
    ]) {
      await seedExpiredInvitation(id, 100);
    }
    await db.execute(
      "UPDATE invitations SET status = 'accepted', accepted_at = '2026-11-08 00:00:00' WHERE id = 'inv_accepted'"
    );
    await db.execute(
      "UPDATE invitations SET created_at = '2026-11-08T00:00:00.000Z' WHERE id = 'inv_created'"
    );
    await db.execute(
      "UPDATE invitations SET expires_at = '2026-11-08T00:00:00.000Z' WHERE id = 'inv_expiry'"
    );
    await db.execute(
      "UPDATE invitations SET expires_at = '2026-10-10 11:59:59' WHERE id = 'inv_legacy_before'"
    );
    await db.execute(
      "UPDATE invitations SET expires_at = '2026-10-10 12:00:01' WHERE id = 'inv_legacy_after'"
    );
    expect(await pruneAccountPii(env, now)).toMatchObject({ invitations: 1 });
    expect(
      await db.queryMany("SELECT id FROM invitations WHERE pii_pseudonymized_at IS NOT NULL")
    ).toEqual([{ id: "inv_legacy_before" }]);
  });

  it("rolls back a batch when a later scrub fails", async () => {
    policy.enforce = true;
    await seedExpiredInvitation("inv_rollback", 31);
    const db = getDb(env);
    await db.execute(`CREATE FUNCTION test_refuse_retention_alert_update() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retention alert scrub refused'; END $$`);
    try {
      await db.execute(`CREATE TRIGGER test_refuse_retention_alert_update
        BEFORE UPDATE ON admin_alerts FOR EACH STATEMENT
        EXECUTE FUNCTION test_refuse_retention_alert_update()`);
      await expect(pruneAccountPii(env)).rejects.toThrow("retention alert scrub refused");
      expect(
        await db.queryOne(
          "SELECT email, status, pii_pseudonymized_at FROM invitations WHERE id = 'inv_rollback'"
        )
      ).toEqual({
        email: "inv_rollback@example.test",
        status: "pending",
        pii_pseudonymized_at: null,
      });
    } finally {
      await db.execute("DROP TRIGGER IF EXISTS test_refuse_retention_alert_update ON admin_alerts");
      await db.execute("DROP FUNCTION test_refuse_retention_alert_update()");
    }
  });

  it("approved age-based cleanup preserves old financial rows and unresolved settlement evidence", async () => {
    policy.enforce = true;
    const db = getDb(env);
    await seedRetentionEvidence(db, { organizationId: ORG.id, userId: OWNER.userId });
    await seedExpiredInvitation("inv_evidence_old", 31);
    const before = await readRetentionEvidence(db);
    expect(await pruneAccountPii(env)).toMatchObject({ invitations: 1 });
    expect(await readRetentionEvidence(db)).toEqual(before);
  });
});
