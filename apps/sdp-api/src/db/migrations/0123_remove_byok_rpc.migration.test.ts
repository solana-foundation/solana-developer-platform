import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl as databaseUrl, env } from "@/test/helpers/env";
import {
  seedHeliusRingsConnection,
  seedOrgProject,
  seedStoredProviderCredential,
} from "@/test/helpers/migration-db";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  runPostgresMigrations,
  splitSqlStatements,
} from "../../../scripts/lib/run-postgres-migrations.mjs";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const migrationFile = "0123_remove_byok_rpc.sql";
let client: Client;

function readMigration(file: string): string {
  return readFileSync(path.join(migrationsDir, file), "utf8");
}

function rpcConnectionsPolicyStatement(): string {
  const tenantTablesLoop = splitSqlStatements(readMigration("0081_tenant_isolation_rls.sql")).find(
    (statement: string) => statement.includes("'rpc_connections',")
  );
  if (!tenantTablesLoop) throw new Error("Missing the 0081 tenant-table policy loop");
  const rpcConnectionsOnly = tenantTablesLoop.replace(
    /ARRAY ARRAY\[[^\]]*\]/,
    "ARRAY ARRAY['rpc_connections']"
  );
  if (rpcConnectionsOnly === tenantTablesLoop) {
    throw new Error("The 0081 tenant-table list no longer matches its expected shape");
  }
  return rpcConnectionsOnly;
}

async function restorePreRemovalSchema(): Promise<void> {
  await client.query(
    [
      readMigration("0060_rpc_connections.sql"),
      readMigration("0068_rpc_connections_drop_last_check.sql"),
      readMigration("0069_organization_rpc_credential_mode.sql"),
      readMigration("0072_rpc_connections_one_per_provider.sql"),
      rpcConnectionsPolicyStatement(),
      `DELETE FROM schema_migrations WHERE version = '${migrationFile}'`,
    ].join(";\n")
  );
}

async function settingsOf(table: "projects" | "organizations", id: string): Promise<unknown> {
  const result = await client.query<{ settings: string | null }>(
    `SELECT settings FROM ${table} WHERE id = $1`,
    [id]
  );
  const { settings } = result.rows[0];
  return settings === null ? null : JSON.parse(settings);
}

describe("0123 BYOK RPC removal", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  beforeEach(async () => {
    await seedTestDatabase(env);
  });

  afterEach(async () => {
    await runPostgresMigrations({ databaseUrl, migrationsDir });
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await client.end();
  });

  it("drops the BYOK RPC schema, every tenant's RPC credentials and the RPC settings keys through the real runner", async () => {
    await restorePreRemovalSchema();
    const tenant = await seedOrgProject(client, "0123");
    const otherTenant = await seedOrgProject(client, "0123_other");
    const rpcOnlyTenant = await seedOrgProject(client, "0123_rpc_only");

    for (const provider of ["helius", "nodit", "triton", "validationcloud", "privy"]) {
      await seedStoredProviderCredential(client, {
        id: `pcred_0123_${provider}`,
        label: provider,
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
        userId: tenant.userId,
        provider,
      });
    }
    await client.query(
      `INSERT INTO provider_credentials (
         id, organization_id, project_id, provider, label, scope, source,
         storage_backend, encrypted_secret_payload, status, created_by
       ) VALUES ('pcred_0123_alchemy', $1, NULL, 'alchemy', 'alchemy', 'organization', 'stored',
                 'encrypted_db', 'test-only', 'active', $2)`,
      [tenant.organizationId, tenant.userId]
    );
    await client.query(
      `INSERT INTO provider_credentials (
         id, organization_id, project_id, provider, label, scope, source,
         storage_backend, secret_ref, secret_version_ref, status, created_by
       ) VALUES ('pcred_0123_quicknode', $1, $2, 'quicknode', 'quicknode', 'project', 'stored',
                 'gcp_secret_manager', 'projects/p/secrets/pcred_0123_quicknode',
                 'projects/p/secrets/pcred_0123_quicknode/versions/1', 'active', $3)`,
      [tenant.organizationId, tenant.projectId, tenant.userId]
    );
    await seedHeliusRingsConnection(client, {
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      userId: tenant.userId,
      tag: "0123",
    });
    await seedStoredProviderCredential(client, {
      id: "pcred_0123_other_helius",
      label: "helius",
      organizationId: otherTenant.organizationId,
      projectId: otherTenant.projectId,
      userId: otherTenant.userId,
      provider: "helius",
    });
    await client.query(
      `INSERT INTO rpc_connections (
         id, organization_id, project_id, provider, scope, provider_credential_id,
         provider_credential_scope_key, network, status, is_default, activated_at, created_by
       ) VALUES ('rpcconn_0123', $1, $2, 'helius', 'project', 'pcred_0123_helius',
                 $2, 'devnet', 'active', TRUE, sdp_iso_now(), $3)`,
      [tenant.organizationId, tenant.projectId, tenant.userId]
    );
    await client.query("UPDATE organizations SET rpc_credential_mode = 'byok' WHERE id = $1", [
      tenant.organizationId,
    ]);
    await client.query("UPDATE projects SET settings = $1 WHERE id = $2", [
      JSON.stringify({ rpcProvider: "helius", rpcEndpoint: "https://x", webhookUrl: "https://y" }),
      tenant.projectId,
    ]);
    await client.query("UPDATE organizations SET settings = $1 WHERE id = $2", [
      JSON.stringify({
        rpcProvider: "helius",
        providerOverrides: { rpc: { helius: true }, custody: { privy: true } },
      }),
      tenant.organizationId,
    ]);
    await client.query("UPDATE organizations SET settings = $1 WHERE id = $2", [
      JSON.stringify({ providerOverrides: { rpc: { triton: true } } }),
      otherTenant.organizationId,
    ]);
    await client.query("UPDATE projects SET settings = $1 WHERE id = $2", [
      JSON.stringify({ rpcProvider: "helius", rpcEndpoint: "https://x" }),
      rpcOnlyTenant.projectId,
    ]);
    await client.query("UPDATE organizations SET settings = $1 WHERE id = $2", [
      JSON.stringify({ rpcProvider: "helius" }),
      rpcOnlyTenant.organizationId,
    ]);

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    const credentials = await client.query<{ id: string; provider: string }>(
      "SELECT id, provider FROM provider_credentials WHERE organization_id = ANY($1) ORDER BY id",
      [[tenant.organizationId, otherTenant.organizationId]]
    );
    expect(credentials.rows).toEqual([
      { id: "pcred_0123_privy", provider: "privy" },
      { id: "pcred_hr_0123", provider: "helius_rings" },
    ]);
    const rpcConnectionsTable = await client.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'rpc_connections'`
    );
    expect(rpcConnectionsTable.rowCount).toBe(0);
    const credentialModeColumn = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'organizations'
          AND column_name = 'rpc_credential_mode'`
    );
    expect(credentialModeColumn.rowCount).toBe(0);
    expect(await settingsOf("projects", tenant.projectId)).toEqual({ webhookUrl: "https://y" });
    expect(await settingsOf("organizations", tenant.organizationId)).toEqual({
      providerOverrides: { custody: { privy: true } },
    });
    expect(await settingsOf("organizations", otherTenant.organizationId)).toEqual({
      providerOverrides: {},
    });
    expect(await settingsOf("projects", rpcOnlyTenant.projectId)).toBeNull();
    expect(await settingsOf("organizations", rpcOnlyTenant.organizationId)).toBeNull();
    expect(await settingsOf("projects", `${tenant.projectId}_production`)).toBeNull();
  });
});
