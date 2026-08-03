import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { SponsorshipBudgetRepository } from "./sponsorship-budget.repository";

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

describe("SponsorshipBudgetRepository", () => {
  beforeEach(async () => {
    const db = getDb(env);
    await db.execute(
      "TRUNCATE sponsorship_budget_policy_revisions, sponsorship_budget_reservations, sponsorship_budget_policies"
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
      path.resolve(import.meta.dirname, "../migrations/postgres/0047_sponsorship_budgets.sql"),
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
});
