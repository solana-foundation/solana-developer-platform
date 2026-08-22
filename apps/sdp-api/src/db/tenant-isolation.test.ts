/**
 * Database-enforced tenant isolation (migration 0067) under the plain
 * NOSUPERUSER/NOBYPASSRLS runtime role. These tests prove the RLS floor holds
 * even when the application layer is bypassed entirely: raw SQL under a
 * tenant identity cannot read or write another organization, identity-less
 * access fails closed, system workers keep their explicit cross-tenant
 * access, and the operator bypass is recorded in the audit ledger.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  runWithoutDatabaseIdentity,
  runWithSystemDatabaseIdentity,
  runWithTenantDatabaseIdentity,
} from "@/db/identity";
import { runWithOperatorDatabaseAccess } from "@/db/operator-access";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  createCounterpartiesRepository,
  createSystemCounterpartiesRepository,
} from "@/db/repositories/repository-factory";
import { SponsorshipBudgetRepository } from "@/db/repositories/sponsorship-budget.repository";
import { createTenantScope } from "@/lib/tenant-scope";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const ORG_A = "org_tenant_isolation_a";
const ORG_B = "org_tenant_isolation_b";
const PROJECT_A = "prj_tenant_isolation_a";
const PROJECT_B = "prj_tenant_isolation_b";
const USER_ID = "usr_tenant_isolation";
const COUNTERPARTY_A = "ctp_tenant_isolation_a";
const COUNTERPARTY_B = "ctp_tenant_isolation_b";

async function seedTwoTenants(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Tenant isolation A', ?, 'individual', 'active')`
      )
      .bind(ORG_A, "tenant-isolation-a"),
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Tenant isolation B', ?, 'individual', 'active')`
      )
      .bind(ORG_B, "tenant-isolation-b"),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'tenant-isolation@example.com', 1, 'active')`
      )
      .bind(USER_ID),
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Tenant isolation A', ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_A, ORG_A, "tenant-isolation-a", USER_ID),
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Tenant isolation B', ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_B, ORG_B, "tenant-isolation-b", USER_ID),
    db
      .prepare(
        `INSERT INTO counterparties
           (id, organization_id, project_id, entity_type, display_name, email, status)
         VALUES (?, ?, ?, 'individual', 'Alice', 'alice@example.com', 'active')`
      )
      .bind(COUNTERPARTY_A, ORG_A, PROJECT_A),
    db
      .prepare(
        `INSERT INTO counterparties
           (id, organization_id, project_id, entity_type, display_name, email, status)
         VALUES (?, ?, ?, 'individual', 'Bob', 'bob@example.com', 'active')`
      )
      .bind(COUNTERPARTY_B, ORG_B, PROJECT_B),
  ]);
}

describe("database-enforced tenant isolation", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedTwoTenants();
  });

  it("runs the suite through a role RLS actually binds", async () => {
    const posture = await getDb(env).queryOne<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
    );
    expect(posture).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("stamps the ambient identity onto the database session", async () => {
    const asTenant = await runWithTenantDatabaseIdentity({ organizationId: ORG_A }, () =>
      getDb(env).queryOne<{ identity: string; organization: string }>(
        `SELECT current_setting('app.tenant_isolation_identity', true) AS identity,
                current_setting('app.tenant_isolation_organization_id', true) AS organization`
      )
    );
    expect(asTenant).toEqual({ identity: "tenant", organization: ORG_A });

    // On a fresh connection the GUC is NULL; on a reused pooled connection a
    // previously stamped transaction-local value resets to ''. The policies
    // treat both as "no identity".
    const bare = await runWithoutDatabaseIdentity("test", () =>
      getDb(env).queryOne<{ identity: string | null }>(
        `SELECT current_setting('app.tenant_isolation_identity', true) AS identity`
      )
    );
    expect(bare?.identity ?? "").toBe("");
  });

  it("hides other organizations' rows from a tenant identity", async () => {
    const rows = await runWithTenantDatabaseIdentity({ organizationId: ORG_A }, () =>
      getDb(env).queryMany<{ id: string }>("SELECT id FROM counterparties ORDER BY id")
    );
    expect(rows).toEqual([{ id: COUNTERPARTY_A }]);

    const organizations = await runWithTenantDatabaseIdentity({ organizationId: ORG_A }, () =>
      getDb(env).queryMany<{ id: string }>("SELECT id FROM organizations")
    );
    expect(organizations).toEqual([{ id: ORG_A }]);
  });

  it("turns cross-tenant updates into zero-row no-ops for a tenant identity", async () => {
    const affected = await runWithTenantDatabaseIdentity({ organizationId: ORG_A }, () =>
      getDb(env).execute("UPDATE counterparties SET display_name = 'stolen' WHERE id = ?", [
        COUNTERPARTY_B,
      ])
    );
    expect(affected).toBe(0);

    const untouched = await runWithSystemDatabaseIdentity("test", () =>
      getDb(env).queryOne<{ display_name: string }>(
        "SELECT display_name FROM counterparties WHERE id = ?",
        [COUNTERPARTY_B]
      )
    );
    expect(untouched?.display_name).toBe("Bob");
  });

  it("rejects cross-tenant inserts from a tenant identity", async () => {
    await expect(
      runWithTenantDatabaseIdentity({ organizationId: ORG_A }, () =>
        getDb(env).execute(
          `INSERT INTO counterparties
             (id, organization_id, project_id, entity_type, display_name, email, status)
           VALUES ('ctp_tenant_isolation_smuggled', ?, ?, 'individual', 'Mallory',
                   'mallory@example.com', 'active')`,
          [ORG_B, PROJECT_B]
        )
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("fails closed when no database identity was established", async () => {
    const rows = await runWithoutDatabaseIdentity("test", () =>
      getDb(env).queryMany<{ id: string }>("SELECT id FROM organizations")
    );
    expect(rows).toEqual([]);

    await expect(
      runWithoutDatabaseIdentity("test", () =>
        getDb(env).execute("UPDATE counterparties SET display_name = 'ghost' WHERE id = ?", [
          COUNTERPARTY_A,
        ])
      )
    ).resolves.toBe(0);
  });

  it("keeps the NULL-scoped sponsorship defaults resolvable under a tenant identity", async () => {
    // Sponsorship admission runs in the request path and resolves the full
    // policy hierarchy — global, organization default (scope_id IS NULL),
    // project default — and trips the breaker when any level is missing. The
    // platform defaults carry no tenant data, so the SELECT policy must keep
    // them visible to every tenant.
    const policies = await runWithTenantDatabaseIdentity({ organizationId: ORG_A }, () =>
      new SponsorshipBudgetRepository(getDb(env)).resolvePolicies({
        network: "devnet",
        organizationId: ORG_A,
        projectId: PROJECT_A,
      })
    );
    expect(policies.map((policy) => policy.scopeType).sort()).toEqual([
      "global",
      "organization",
      "project",
    ]);
  });

  it("keeps explicit cross-tenant access for the system identity", async () => {
    const rows = await runWithSystemDatabaseIdentity("test", () =>
      getDb(env).queryMany<{ id: string }>("SELECT id FROM organizations ORDER BY id")
    );
    expect(rows.map((row) => row.id)).toEqual([ORG_A, ORG_B]);
  });

  it("scopes transactions to the identity that opened them", async () => {
    const visible = await runWithTenantDatabaseIdentity({ organizationId: ORG_B }, () =>
      getDb(env).transaction(async (tx) => {
        const rows = await tx
          .prepare("SELECT id FROM counterparties ORDER BY id")
          .all<{ id: string }>();
        return rows.rows;
      })
    );
    expect(visible).toEqual([{ id: COUNTERPARTY_B }]);
  });

  it("grants operator access only through the audited break-glass path", async () => {
    const organizations = await runWithOperatorDatabaseAccess(
      env,
      { actor: "ops:tenant-isolation-test", reason: "verify break-glass audit" },
      () => getDb(env).queryMany<{ id: string }>("SELECT id FROM organizations ORDER BY id")
    );
    expect(organizations.map((row) => row.id)).toEqual([ORG_A, ORG_B]);

    const auditRow = await runWithSystemDatabaseIdentity("test", () =>
      getDb(env).queryOne<{ action: string; metadata: string }>(
        "SELECT action, metadata FROM audit_logs WHERE resource_id = ?",
        ["operator-bypass:ops:tenant-isolation-test"]
      )
    );
    expect(auditRow?.action).toBe("maintenance");
    expect(JSON.parse(auditRow?.metadata ?? "{}")).toMatchObject({
      tenantIsolationBypass: true,
      actor: "ops:tenant-isolation-test",
      reason: "verify break-glass audit",
    });
  });

  it("refuses operator access without an actor and reason", async () => {
    await expect(
      runWithOperatorDatabaseAccess(env, { actor: " ", reason: "" }, async () => "never")
    ).rejects.toThrow(/actor and reason/);
  });

  describe("counterparty provider lookup integrity", () => {
    it("lets the scoped repository path write provider data for its own tenant only", async () => {
      const scope = createTenantScope({ organizationId: ORG_A, projectId: PROJECT_A });
      const repository = createCounterpartiesRepository(env, scope);

      const updated = await runWithTenantDatabaseIdentity(scope, () =>
        repository.mutateProviderData({
          counterpartyId: COUNTERPARTY_A,
          organizationId: ORG_A,
          projectId: PROJECT_A,
          mutate: (current) => ({
            ...current,
            bvnk: { customer: { customerReference: "tenant-written-ref" } },
          }),
        })
      );
      expect(updated).not.toBeNull();

      const persisted = await runWithSystemDatabaseIdentity("test", () =>
        getDb(env).queryOne<{ bvnk_customer_reference: string | null }>(
          "SELECT bvnk_customer_reference FROM counterparties WHERE id = ?",
          [COUNTERPARTY_A]
        )
      );
      expect(persisted?.bvnk_customer_reference).toBe("tenant-written-ref");

      // The same scoped path aimed at another tenant's row resolves nothing.
      const crossTenant = await runWithTenantDatabaseIdentity(scope, () =>
        repository.mutateProviderData({
          counterpartyId: COUNTERPARTY_B,
          organizationId: ORG_A,
          projectId: PROJECT_A,
          mutate: (current) => ({
            ...current,
            bvnk: { customer: { customerReference: "smuggled-ref" } },
          }),
        })
      );
      expect(crossTenant).toBeNull();
    });

    it("rejects two tenants racing to claim the same provider reference", async () => {
      const repository = createSystemCounterpartiesRepository(env);
      const claim = (counterpartyId: string, organizationId: string, projectId: string) =>
        runWithSystemDatabaseIdentity("test", () =>
          repository.upsertBvnkCustomerProviderData({
            counterpartyId,
            organizationId,
            projectId,
            customer: { customerReference: "shared-provider-ref" },
          })
        );

      const outcomes = await Promise.allSettled([
        claim(COUNTERPARTY_A, ORG_A, PROJECT_A),
        claim(COUNTERPARTY_B, ORG_B, PROJECT_B),
      ]);

      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
      );
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(isPostgresUniqueViolation(rejected[0].reason)).toBe(true);

      // Exactly one row holds the reference afterwards.
      const holders = await runWithSystemDatabaseIdentity("test", () =>
        getDb(env).queryMany<{ id: string }>(
          "SELECT id FROM counterparties WHERE bvnk_customer_reference = ?",
          ["shared-provider-ref"]
        )
      );
      expect(holders).toHaveLength(1);
    });

    it("rejects a JSON-only claim that collides with another tenant's column value", async () => {
      await runWithSystemDatabaseIdentity("test", () =>
        getDb(env).execute("UPDATE counterparties SET bvnk_customer_reference = ? WHERE id = ?", [
          "dual-write-ref",
          COUNTERPARTY_A,
        ])
      );

      // A row whose reference lives only in provider_data JSON (the dual-write
      // fallback the lookups still honour) must not be able to shadow another
      // tenant's denormalized claim.
      await expect(
        runWithSystemDatabaseIdentity("test", () =>
          getDb(env).execute(
            `UPDATE counterparties
             SET provider_data = '{"bvnk":{"customer":{"customerReference":"dual-write-ref"}}}'::jsonb
             WHERE id = ?`,
            [COUNTERPARTY_B]
          )
        )
      ).rejects.toSatisfy(isPostgresUniqueViolation);
    });
  });
});
