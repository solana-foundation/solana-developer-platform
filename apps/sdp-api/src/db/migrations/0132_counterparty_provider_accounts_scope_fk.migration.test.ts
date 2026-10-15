import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl as databaseUrl, env } from "@/test/helpers/env";
import {
  FK_VIOLATION,
  seedCounterparty,
  seedCustomerLink,
  seedOrgProject,
} from "@/test/helpers/migration-db";
import { seedTestDatabase } from "@/test/mocks/db";
import { runPostgresMigrations } from "../../../scripts/lib/run-postgres-migrations.mjs";
import {
  COUNTERPARTY_PROVIDER_ACCOUNTS_SCOPE_FK_MIGRATION,
  restorePreCounterpartyProviderAccountsScopeSchema,
} from "./counterparty-provider-accounts-scope-schema";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const scopeKey = "counterparty_provider_accounts_counterparty_scope_fkey";
const legacyKey = "counterparty_provider_accounts_counterparty_id_fkey";
let client: Client;

async function idsOf(
  table: "counterparties" | "counterparty_provider_accounts",
  organizationId: string
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE organization_id = $1 ORDER BY id`,
    [organizationId]
  );
  return result.rows.map((row) => row.id);
}

async function counterpartyKeys(): Promise<{ conname: string }[]> {
  const result = await client.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'counterparty_provider_accounts'::regclass
        AND confrelid = 'counterparties'::regclass
      ORDER BY conname`
  );
  return result.rows;
}

async function recordedMigrations(): Promise<{ version: string }[]> {
  const result = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations WHERE version = $1",
    [COUNTERPARTY_PROVIDER_ACCOUNTS_SCOPE_FK_MIGRATION]
  );
  return result.rows;
}

beforeAll(async () => {
  client = new Client({ connectionString: databaseUrl });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe("0132 counterparty provider accounts scope key migration", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await restorePreCounterpartyProviderAccountsScopeSchema(client);
  });

  afterEach(async () => {
    await seedTestDatabase(env);
    await runPostgresMigrations({ databaseUrl, migrationsDir });
  });

  it.each([{ mismatch: "project" }, { mismatch: "organization" }] as const)(
    "fails the migration and leaves it unrecorded when a provider account's $mismatch differs from its counterparty's",
    async ({ mismatch }) => {
      const tenant = await seedOrgProject(client, `0132_${mismatch}`);
      const otherTenant = await seedOrgProject(client, `0132_${mismatch}_other`);
      await seedCounterparty(client, {
        id: `cpty_0132_${mismatch}`,
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
      });
      const accountScope =
        mismatch === "project"
          ? { organizationId: tenant.organizationId, projectId: `${tenant.projectId}_production` }
          : { organizationId: otherTenant.organizationId, projectId: tenant.projectId };
      await seedCustomerLink(client, {
        id: `cpa_0132_${mismatch}`,
        organizationId: accountScope.organizationId,
        projectId: accountScope.projectId,
        counterpartyId: `cpty_0132_${mismatch}`,
      });

      await expect(runPostgresMigrations({ databaseUrl, migrationsDir })).rejects.toMatchObject({
        code: FK_VIOLATION,
        constraint: scopeKey,
      });

      expect(await idsOf("counterparty_provider_accounts", accountScope.organizationId)).toEqual([
        `cpa_0132_${mismatch}`,
      ]);
      expect(await counterpartyKeys()).toEqual([{ conname: legacyKey }]);
      expect(await recordedMigrations()).toEqual([]);
    }
  );

  it("applies the migration and keeps provider accounts that share their counterparty's organization and project", async () => {
    const tenant = await seedOrgProject(client, "0132_conforming");
    const productionProjectId = `${tenant.projectId}_production`;
    await seedCounterparty(client, {
      id: "cpty_0132_conforming_sandbox",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });
    await seedCustomerLink(client, {
      id: "cpa_0132_conforming_sandbox",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      counterpartyId: "cpty_0132_conforming_sandbox",
    });
    await seedCounterparty(client, {
      id: "cpty_0132_conforming_production",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
    });
    await seedCustomerLink(client, {
      id: "cpa_0132_conforming_production",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      counterpartyId: "cpty_0132_conforming_production",
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await idsOf("counterparty_provider_accounts", tenant.organizationId)).toEqual([
      "cpa_0132_conforming_production",
      "cpa_0132_conforming_sandbox",
    ]);
    expect(await counterpartyKeys()).toEqual([{ conname: scopeKey }]);
    expect(await recordedMigrations()).toEqual([
      { version: COUNTERPARTY_PROVIDER_ACCOUNTS_SCOPE_FK_MIGRATION },
    ]);
  });

  it("rejects a provider account under another project's counterparty and refuses to delete or re-home a counterparty that holds one", async () => {
    const tenant = await seedOrgProject(client, "0132_enforced");
    const productionProjectId = `${tenant.projectId}_production`;
    await seedCounterparty(client, {
      id: "cpty_0132_enforced",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });
    await seedCustomerLink(client, {
      id: "cpa_0132_enforced",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      counterpartyId: "cpty_0132_enforced",
    });
    await seedCounterparty(client, {
      id: "cpty_0132_enforced_production",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    await expect(
      seedCustomerLink(client, {
        id: "cpa_0132_enforced_cross_project",
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
        counterpartyId: "cpty_0132_enforced_production",
      })
    ).rejects.toMatchObject({ code: FK_VIOLATION, constraint: scopeKey });
    await expect(
      client.query("DELETE FROM counterparties WHERE id = $1", ["cpty_0132_enforced"])
    ).rejects.toMatchObject({ code: FK_VIOLATION, constraint: scopeKey });
    await expect(
      client.query("UPDATE counterparties SET project_id = $1 WHERE id = $2", [
        productionProjectId,
        "cpty_0132_enforced",
      ])
    ).rejects.toMatchObject({ code: FK_VIOLATION, constraint: scopeKey });

    expect({
      counterparties: await idsOf("counterparties", tenant.organizationId),
      providerAccounts: await idsOf("counterparty_provider_accounts", tenant.organizationId),
    }).toEqual({
      counterparties: ["cpty_0132_enforced", "cpty_0132_enforced_production"],
      providerAccounts: ["cpa_0132_enforced"],
    });
  });
});
