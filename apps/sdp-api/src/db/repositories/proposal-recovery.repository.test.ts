import { beforeEach, describe, expect, it } from "vitest";
import { type DatabaseExecutor, getDb } from "@/db/client";
import type { MoneyPrincipal } from "@/lib/money-principal";
import { env } from "@/test/helpers/env";
import { organizationMember, seedOrganizationMembers } from "@/test/helpers/organization-members";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { holdTransaction, untilLockWaiters } from "@/test/helpers/row-locks";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  adoptLegacyCustodyProposals,
  CUSTODY_PROPOSAL_DISCOVERY_GRACE_MS,
  requestPendingProposalRecovery,
} from "./proposal-recovery.repository";

const ORGANIZATION = { id: "org_proposal_recovery", slug: "proposal-recovery" };
const FOREIGN_ORGANIZATION = {
  id: "org_proposal_recovery_foreign",
  slug: "proposal-recovery-foreign",
};
const MEMBER = organizationMember("proposal_recovery", "admin");
const FOREIGN_MEMBER = organizationMember("proposal_recovery_foreign", "admin");
const KEY = { kind: "api_key", apiKeyId: "key_proposal_recovery" } as const;
const NOW = "2026-11-11T10:00:00.000Z";
let sandboxProjectId: string;
let productionProjectId: string;
let foreignProjectId: string;

async function seedTransfer(input: {
  id: string;
  principal: MoneyPrincipal | null;
  projectId?: string;
  organizationId?: string;
  status?: "processing" | "confirmed" | "failed";
  native?: boolean;
  createdAt?: string;
}): Promise<void> {
  await getDb(env).execute(
    `INSERT INTO payment_transfers
       (id, organization_id, project_id, wallet_id, source_address,
        destination_address, token, amount, type, direction, status,
        created_at, updated_at, provider_data, initiated_by_principal, initiated_by_key_id)
     VALUES (?, ?, ?, 'provider-wallet', 'Source', 'Destination', 'SOL', '1',
             'transfer', 'outbound', ?, ?, ?, ?::jsonb, ?::jsonb, ?)`,
    [
      input.id,
      input.organizationId ?? ORGANIZATION.id,
      input.projectId ?? sandboxProjectId,
      input.status ?? "processing",
      input.createdAt ?? NOW,
      input.createdAt ?? NOW,
      JSON.stringify(input.native === false ? {} : { fireblocksTransfer: {} }),
      input.principal === null ? null : JSON.stringify(input.principal),
      KEY.apiKeyId,
    ]
  );
}

async function queuedIds(db: DatabaseExecutor = getDb(env)): Promise<string[]> {
  const rows = await db.queryMany<{ id: string }>(
    "SELECT payment_transfer_id AS id FROM custody_proposals WHERE recheck_requested_at IS NOT NULL ORDER BY payment_transfer_id"
  );
  return rows.map((row) => row.id);
}

describe("requestPendingProposalRecovery", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await seedOrganizationMembers(db, { organization: ORGANIZATION, members: [MEMBER] });
    await seedOrganizationMembers(db, {
      organization: FOREIGN_ORGANIZATION,
      members: [FOREIGN_MEMBER],
    });
    const projects = await seedDefaultProjects(db, {
      organizationId: ORGANIZATION.id,
      createdBy: MEMBER.userId,
      members: [MEMBER.userId],
    });
    sandboxProjectId = projects.sandbox.id;
    productionProjectId = projects.production.id;
    const foreignProjects = await seedDefaultProjects(db, {
      organizationId: FOREIGN_ORGANIZATION.id,
      createdBy: FOREIGN_MEMBER.userId,
      members: [FOREIGN_MEMBER.userId],
    });
    foreignProjectId = foreignProjects.sandbox.id;
  });

  it("queues only the exact effective principal in the requested project", async () => {
    await seedTransfer({ id: "matching", principal: KEY });
    await seedTransfer({ id: "other_project", principal: KEY, projectId: productionProjectId });
    await seedTransfer({
      id: "other_organization",
      principal: KEY,
      organizationId: FOREIGN_ORGANIZATION.id,
      projectId: foreignProjectId,
    });
    await seedTransfer({ id: "different_key", principal: { ...KEY, apiKeyId: "key_other" } });
    await seedTransfer({ id: "member", principal: { kind: "member", userId: KEY.apiKeyId } });
    await seedTransfer({ id: "legacy_audit_key", principal: null });
    await seedTransfer({ id: "signed_locally", principal: KEY, native: false });
    await seedTransfer({ id: "confirmed", principal: KEY, status: "confirmed" });
    await seedTransfer({ id: "failed", principal: KEY, status: "failed" });

    await requestPendingProposalRecovery(getDb(env), {
      organizationId: ORGANIZATION.id,
      projectId: sandboxProjectId,
      principal: KEY,
      now: NOW,
    });

    expect(await queuedIds()).toEqual(["matching"]);
  });

  it("queues member transfers across projects without treating their keys or mandates as theirs", async () => {
    const principal = { kind: "member", userId: MEMBER.userId } as const;
    await seedTransfer({ id: "member_sandbox", principal });
    await seedTransfer({ id: "member_production", principal, projectId: productionProjectId });
    await seedTransfer({ id: "api_key", principal: KEY });
    await seedTransfer({
      id: "mandate",
      principal: { kind: "mandate", recurringPaymentId: MEMBER.userId },
    });
    await seedTransfer({
      id: "payment_request",
      principal: { kind: "payment_request", paymentRequestId: MEMBER.userId },
    });

    await requestPendingProposalRecovery(getDb(env), {
      organizationId: ORGANIZATION.id,
      principal,
      now: NOW,
    });

    expect(await queuedIds()).toEqual(["member_production", "member_sandbox"]);
  });

  it.each(["worker", "revocation"] as const)(
    "keeps concurrent worker/revocation adoption atomic when %s inserts first",
    async (first) => {
      await seedTransfer({
        id: "concurrent_adoption",
        principal: KEY,
        createdAt: new Date(Date.parse(NOW) - CUSTODY_PROPOSAL_DISCOVERY_GRACE_MS).toISOString(),
      });
      const db = getDb(env);
      const workerAdopt = (tx: DatabaseExecutor) =>
        adoptLegacyCustodyProposals(tx, { environment: "sandbox", now: NOW, limit: 50 });
      const revokeAndQueue = (tx: DatabaseExecutor) =>
        requestPendingProposalRecovery(tx, {
          organizationId: ORGANIZATION.id,
          principal: KEY,
          now: NOW,
        });
      const lock = await holdTransaction(db, async (tx) => {
        if (first === "worker") await workerAdopt(tx);
        else await revokeAndQueue(tx);
      });
      const competing = db.transaction(async (tx) => {
        if (first === "worker") await revokeAndQueue(tx);
        else await workerAdopt(tx);
      });
      try {
        // The loser has the same missing-row snapshot and reaches the unique
        // index while the winner's insert remains uncommitted.
        await untilLockWaiters(db, { fragment: "WITH clock AS", count: 1 });
      } finally {
        await lock.commit();
      }
      await competing;
      expect(
        await db.queryMany(
          "SELECT payment_transfer_id FROM custody_proposals WHERE payment_transfer_id = ?",
          ["concurrent_adoption"]
        )
      ).toEqual([{ payment_transfer_id: "concurrent_adoption" }]);
      expect(await queuedIds()).toEqual(["concurrent_adoption"]);
    }
  );

  it("rolls the enqueue back with its authority transaction", async () => {
    await seedTransfer({ id: "transaction", principal: KEY });
    await expect(
      getDb(env).transaction(async (tx) => {
        await requestPendingProposalRecovery(tx, {
          organizationId: ORGANIZATION.id,
          principal: KEY,
          now: NOW,
        });
        expect(await queuedIds(tx)).toEqual(["transaction"]);
        throw new Error("authority transaction rolled back");
      })
    ).rejects.toThrow("authority transaction rolled back");
    expect(await queuedIds()).toEqual([]);
  });

  it("preserves a new request after a worker claim even when its timestamp is older", async () => {
    await seedTransfer({ id: "racing", principal: KEY });
    const db = getDb(env);
    const checkedAt = "2026-11-11T10:01:00.000Z";
    await requestPendingProposalRecovery(db, {
      organizationId: ORGANIZATION.id,
      principal: KEY,
      now: NOW,
    });
    await db.execute(
      `UPDATE custody_proposals SET recheck_requested_at = NULL, last_checked_at = ?
        WHERE payment_transfer_id = 'racing'`,
      [checkedAt]
    );
    await requestPendingProposalRecovery(db, {
      organizationId: ORGANIZATION.id,
      principal: KEY,
      now: NOW,
    });
    expect(
      await db.queryOne(
        `SELECT cp.recheck_requested_at, cp.last_checked_at,
              pt.initiated_by_principal, pt.status, pt.updated_at
         FROM payment_transfers pt JOIN custody_proposals cp ON cp.payment_transfer_id = pt.id
         WHERE pt.id = 'racing'`
      )
    ).toEqual({
      recheck_requested_at: NOW,
      last_checked_at: checkedAt,
      initiated_by_principal: KEY,
      status: "processing",
      updated_at: NOW,
    });
  });
});
