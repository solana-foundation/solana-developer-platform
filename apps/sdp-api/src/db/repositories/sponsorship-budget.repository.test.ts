import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  type CreateSponsorshipReservationInput,
  SponsorshipBudgetRepository,
} from "./sponsorship-budget.repository";

async function insertPolicy(input: {
  id: string;
  scopeType: "global" | "organization" | "project";
  scopeId: string | null;
  hourly?: number;
}) {
  await getDb(env).execute(
    `INSERT INTO sponsorship_budget_policies (
       id, network, scope_type, scope_id, enabled, per_transaction_lamports,
       hourly_lamports, daily_lamports, version, updated_by, update_reason
     ) VALUES (?, 'devnet', ?, ?, TRUE, 10, ?, 1000, 1, 'test', 'seed')`,
    [input.id, input.scopeType, input.scopeId, input.hourly ?? 100]
  );
}

function reservationInput(id: string): CreateSponsorshipReservationInput {
  return {
    id,
    network: "devnet",
    productEnvironment: "sandbox",
    organizationId: "org_1",
    projectId: "project_1",
    actorType: "api_key",
    actorId: "key_1",
    transactionDigest: "digest_1",
    feePayer: "fee_payer_1",
    providerConfigFingerprint: "config_1",
    recentBlockhash: "blockhash_1",
    reservedLamports: 5,
    hourBucket: "2026-08-03T10:00:00.000Z",
    dayBucket: "2026-08-03T00:00:00.000Z",
    policyVersions: { global: 1 },
  };
}

describe("SponsorshipBudgetRepository", () => {
  beforeEach(async () => {
    const db = getDb(env);
    await db.execute(
      "TRUNCATE sponsorship_budget_policy_revisions, sponsorship_budget_reservations, sponsorship_budget_policies, sponsorship_reconciliation_state"
    );
    await insertPolicy({ id: "global", scopeType: "global", scopeId: null });
    await insertPolicy({ id: "org_default", scopeType: "organization", scopeId: null });
    await insertPolicy({ id: "project_default", scopeType: "project", scopeId: null });
  });

  it("prefers exact tenant policies and falls back independently at each scope", async () => {
    await insertPolicy({
      id: "org_exact",
      scopeType: "organization",
      scopeId: "org_1",
      hourly: 50,
    });
    const policies = await new SponsorshipBudgetRepository(getDb(env)).resolvePolicies({
      network: "devnet",
      organizationId: "org_1",
      projectId: "project_1",
    });
    expect(policies.map((policy) => policy.id)).toEqual(["global", "org_exact", "project_default"]);
  });

  it("toggles enabled without clobbering a concurrently-updated limit", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));
    const updated = await repository.upsertPolicy({
      network: "devnet",
      scopeType: "global",
      scopeId: null,
      enabled: true,
      perTransactionLamports: 111,
      hourlyLamports: 222,
      dailyLamports: 333,
      operator: "operator",
      reason: "raise limits",
    });

    const disabled = await repository.setPolicyEnabled({
      network: "devnet",
      scopeType: "global",
      scopeId: null,
      enabled: false,
      operator: "system:sponsorship-breaker",
      reason: "trip",
    });
    expect(disabled).not.toBeNull();
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.perTransactionLamports).toBe(111);
    expect(disabled?.hourlyLamports).toBe(222);
    expect(disabled?.dailyLamports).toBe(333);
    expect(disabled?.version).toBe(updated.version + 1);

    const noop = await repository.setPolicyEnabled({
      network: "devnet",
      scopeType: "global",
      scopeId: null,
      enabled: false,
      operator: "system:sponsorship-breaker",
      reason: "trip",
    });
    expect(noop).toBeNull();

    const provenanceOverwrite = await repository.setPolicyEnabled({
      network: "devnet",
      scopeType: "global",
      scopeId: null,
      enabled: false,
      operator: "operator:oncall",
      reason: "manual kill during breaker trip",
    });
    expect(provenanceOverwrite?.enabled).toBe(false);
    expect(provenanceOverwrite?.updatedBy).toBe("operator:oncall");
  });

  it("resumes the breaker only when the trip provenance still matches", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));

    const tripped = await repository.tripGlobalBreaker("devnet", "config unavailable");
    expect(tripped?.enabled).toBe(false);

    const resumed = await repository.resumeGlobalBreaker(
      "devnet",
      "config unavailable",
      "config readable again"
    );
    expect(resumed?.enabled).toBe(true);
    expect(resumed?.version).toBe((tripped?.version ?? 0) + 1);

    const alreadyEnabled = await repository.resumeGlobalBreaker(
      "devnet",
      "config unavailable",
      "config readable again"
    );
    expect(alreadyEnabled).toBeNull();
  });

  it("does not resume a policy disabled by an operator or for another reason", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));

    await repository.setPolicyEnabled({
      network: "devnet",
      scopeType: "global",
      scopeId: null,
      enabled: false,
      operator: "operator:oncall",
      reason: "manual kill",
    });
    expect(
      await repository.resumeGlobalBreaker("devnet", "config unavailable", "config readable again")
    ).toBeNull();

    await repository.setPolicyEnabled({
      network: "devnet",
      scopeType: "global",
      scopeId: null,
      enabled: true,
      operator: "operator:oncall",
      reason: "restore",
    });
    await repository.tripGlobalBreaker("devnet", "overspend detected");
    expect(
      await repository.resumeGlobalBreaker("devnet", "config unavailable", "config readable again")
    ).toBeNull();
  });

  it("counts consecutive provider config failures durably and resets on success", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));

    expect(await repository.recordProviderConfigFailure("devnet")).toBe(1);
    expect(await repository.recordProviderConfigFailure("devnet")).toBe(2);
    expect(await repository.recordProviderConfigFailure("devnet")).toBe(3);
    expect(await repository.recordProviderConfigFailure("mainnet")).toBe(1);

    await repository.resetProviderConfigFailures("devnet");
    expect(await repository.recordProviderConfigFailure("devnet")).toBe(1);
    expect(await repository.recordProviderConfigFailure("mainnet")).toBe(2);
  });

  it("blocks auto-resume after an operator kill lands over an existing breaker trip", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));

    await repository.tripGlobalBreaker("devnet", "config unavailable");
    const killed = await repository.setPolicyEnabled({
      network: "devnet",
      scopeType: "global",
      scopeId: null,
      enabled: false,
      operator: "operator:oncall",
      reason: "keep sponsorship down during incident review",
    });
    expect(killed?.updatedBy).toBe("operator:oncall");

    expect(
      await repository.resumeGlobalBreaker("devnet", "config unavailable", "config readable again")
    ).toBeNull();
  });

  it("blocks auto-resume after an integrity trip lands over a config-unavailability trip", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));

    await repository.tripGlobalBreaker("devnet", "config unavailable", { recoverable: true });
    const integrityTrip = await repository.tripGlobalBreaker("devnet", "overspend detected");
    expect(integrityTrip?.updateReason).toBe("overspend detected");

    expect(
      await repository.resumeGlobalBreaker("devnet", "config unavailable", "config readable again")
    ).toBeNull();
  });

  it("does not let a recoverable config trip downgrade a stronger disable", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));

    await repository.setPolicyEnabled({
      network: "devnet",
      scopeType: "global",
      scopeId: null,
      enabled: false,
      operator: "operator:oncall",
      reason: "manual kill",
    });
    const configTrip = await repository.tripGlobalBreaker("devnet", "config unavailable", {
      recoverable: true,
    });
    expect(configTrip).toBeNull();

    const policy = await repository.getGlobalPolicy("devnet");
    expect(policy?.updatedBy).toBe("operator:oncall");
    expect(
      await repository.resumeGlobalBreaker("devnet", "config unavailable", "config readable again")
    ).toBeNull();
  });

  it("writes an audited revision for each policy change and prevents mutation", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));
    const changed = await repository.upsertPolicy({
      network: "devnet",
      scopeType: "global",
      scopeId: null,
      enabled: false,
      perTransactionLamports: 10,
      hourlyLamports: 100,
      dailyLamports: 1000,
      operator: "operator@example.com",
      reason: "incident kill switch",
    });
    expect(changed.version).toBe(2);
    const revision = await getDb(env).queryOne<{
      version: number;
      changed_by: string;
      change_reason: string;
    }>(
      `SELECT version, changed_by, change_reason
       FROM sponsorship_budget_policy_revisions WHERE policy_id = 'global'`
    );
    expect(revision).toEqual({
      version: 2,
      changed_by: "operator@example.com",
      change_reason: "incident kill switch",
    });
    await expect(
      getDb(env).execute(
        "UPDATE sponsorship_budget_policy_revisions SET change_reason = 'tampered' WHERE policy_id = 'global'"
      )
    ).rejects.toThrow("append-only");
    await expect(
      getDb(env).execute(
        "DELETE FROM sponsorship_budget_policy_revisions WHERE policy_id = 'global'"
      )
    ).rejects.toThrow("append-only");
  });

  it("keeps the reviewed devnet/mainnet seed limits exact", () => {
    const migration = readFileSync(
      path.resolve(import.meta.dirname, "../migrations/postgres/0055_sponsorship_budgets.sql"),
      "utf8"
    );
    expect(migration).toContain(
      "('sbp_devnet_global', 'devnet', 'global', NULL, TRUE, 10000000, 2000000000, 10000000000"
    );
    expect(migration).toContain(
      "('sbp_devnet_project_default', 'devnet', 'project', NULL, TRUE, 10000000, 1000000000, 3000000000"
    );
    expect(migration).toContain(
      "('sbp_mainnet_global', 'mainnet', 'global', NULL, FALSE, 10000000, 500000000, 1000000000"
    );
    expect(migration).toContain(
      "('sbp_mainnet_project_default', 'mainnet', 'project', NULL, TRUE, 10000000, 100000000, 250000000"
    );
  });

  it("restores migration-equivalent defaults after a shared test reset", async () => {
    await seedTestDatabase(env);
    const repository = new SponsorshipBudgetRepository(getDb(env));
    const policies = await repository.listPolicies();
    expect(policies.map((entry) => entry.id)).toEqual([
      "sbp_devnet_global",
      "sbp_devnet_org_default",
      "sbp_devnet_project_default",
      "sbp_mainnet_global",
      "sbp_mainnet_org_default",
      "sbp_mainnet_project_default",
    ]);
    expect(
      await getDb(env).queryOne<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM sponsorship_budget_policy_revisions"
      )
    ).toEqual({ count: 6 });
  });

  it("returns window usage sums as JavaScript numbers, not NUMERIC strings", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));
    const input = reservationInput("reservation_usage_types");
    await expect(repository.createReservation(input)).resolves.toBe(true);
    const usage = await repository.getWindowUsage({
      network: input.network,
      organizationId: input.organizationId,
      projectId: input.projectId,
      hourBucket: input.hourBucket,
      dayBucket: input.dayBucket,
    });
    expect(usage).toEqual({
      hour: { global: 5, organization: 5, project: 5 },
      day: { global: 5, organization: 5, project: 5 },
    });
  });

  it("excludes the named reservation from window usage and live reservations", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));
    const self = reservationInput("reservation_self");
    const other = reservationInput("reservation_other");
    await expect(repository.createReservation(self)).resolves.toBe(true);
    await expect(repository.createReservation(other)).resolves.toBe(true);

    const snapshot = await repository.loadWindowAdmissionSnapshot({
      network: self.network,
      organizationId: self.organizationId,
      projectId: self.projectId,
      hourBucket: self.hourBucket,
      dayBucket: self.dayBucket,
      excludeReservationId: self.id,
    });

    expect(snapshot.usage).toEqual({
      hour: { global: 5, organization: 5, project: 5 },
      day: { global: 5, organization: 5, project: 5 },
    });
    expect(snapshot.liveReservations.hour.map((reservation) => reservation.id)).toEqual([
      "reservation_other",
    ]);
    expect(snapshot.liveReservations.day.map((reservation) => reservation.id)).toEqual([
      "reservation_other",
    ]);
  });

  it("reopens a released reservation exactly once and only after Redis settlement", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));
    const input = reservationInput("reservation_retry");
    await expect(repository.createReservation(input)).resolves.toBe(true);
    await expect(repository.markReleased(input.id, 1, "provider rejected")).resolves.toBe(true);

    await expect(repository.reopenReleasedReservation(input, 1)).resolves.toBeNull();
    await expect(repository.markRedisSettled(input.id, 1)).resolves.toBe(true);
    const reopened = await Promise.all([
      repository.reopenReleasedReservation(input, 1),
      repository.reopenReleasedReservation(input, 1),
    ]);
    expect(reopened.filter((attempt) => attempt === 2)).toHaveLength(1);
    expect(reopened.filter((attempt) => attempt === null)).toHaveLength(1);
  });

  it("rejects every stale attempt mutation after a reservation is reopened", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));
    const input = reservationInput("reservation_stale_attempt");
    await repository.createReservation(input);
    await repository.markReleased(input.id, 1, "provider rejected");
    await expect(repository.markRedisSettled(input.id, 1)).resolves.toBe(true);
    await expect(repository.reopenReleasedReservation(input, 1)).resolves.toBe(2);

    await expect(repository.markSubmitted(input.id, 1, "stale_signature")).resolves.toBe("stale");
    await expect(repository.markChargedUnknown(input.id, 1, "stale timeout")).resolves.toBe(false);
    await expect(repository.markReleased(input.id, 1, "stale rejection")).resolves.toBe(false);
    await expect(repository.recordReconciliationMiss(input.id, 1, 0)).resolves.toBe(false);
    await expect(
      repository.markSigned(input.id, 2, "signed_transaction", "signature_2")
    ).resolves.toBe("persisted");
    await expect(repository.settleReservation(input.id, 1, "released", 0)).resolves.toBe(false);
    await expect(repository.settleReservation(input.id, 2, "committed", 4)).resolves.toBe(true);

    await expect(repository.markRedisSettled(input.id, 1)).resolves.toBe(false);
    expect(
      await getDb(env).queryOne<{
        attempt: number;
        status: string;
        redis_settled_at: string | null;
      }>(
        `SELECT attempt, status, redis_settled_at
         FROM sponsorship_budget_reservations WHERE id = ?`,
        [input.id]
      )
    ).toEqual({ attempt: 2, status: "committed", redis_settled_at: null });
  });

  it("reports a duplicate_signature when another reservation already owns the signature", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));
    const first = reservationInput("reservation_sig_owner");
    const second = { ...reservationInput("reservation_sig_racer"), transactionDigest: "digest_2" };
    await repository.createReservation(first);
    await repository.createReservation(second);
    await expect(repository.markSubmitted(first.id, 1, "shared_signature")).resolves.toBe(
      "persisted"
    );
    await expect(repository.markSubmitted(second.id, 1, "shared_signature")).resolves.toBe(
      "duplicate_signature"
    );
    await expect(
      repository.markSigned(second.id, 1, "signed_transaction", "shared_signature")
    ).resolves.toBe("duplicate_signature");
  });

  it("retains an ambiguous submitted attempt as charged unknown", async () => {
    const repository = new SponsorshipBudgetRepository(getDb(env));
    const input = reservationInput("reservation_submitted_unknown");
    await repository.createReservation(input);
    await expect(repository.markSubmitted(input.id, 1, "signature_1")).resolves.toBe("persisted");
    await expect(
      repository.markChargedUnknown(input.id, 1, "history remained unavailable")
    ).resolves.toBe(true);
    await expect(repository.getReservation(input.id)).resolves.toMatchObject({
      attempt: 1,
      status: "charged_unknown",
      actualLamports: null,
      reservedLamports: 5,
    });
  });
});
