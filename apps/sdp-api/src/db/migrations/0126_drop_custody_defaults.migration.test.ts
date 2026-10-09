import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CustodyConfigStatus,
  CustodyConnectionCheckStatus,
  CustodyConnectionLifecycle,
  CustodyProvider,
} from "@sdp/types";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import { adminDatabaseUrl as databaseUrl, env } from "@/test/helpers/env";
import {
  CHECK_VIOLATION,
  expectSqlstate,
  FK_VIOLATION,
  seedOrgProject,
  seedStoredProviderCredential,
} from "@/test/helpers/migration-db";
import { seedTestDatabase } from "@/test/mocks/db";
import { runPostgresMigrations } from "../../../scripts/lib/run-postgres-migrations.mjs";
import {
  CUSTODY_DEFAULTS_DROP_MIGRATION,
  restorePreCustodyDefaultsDropSchema,
} from "./custody-defaults-schema";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const RAISE_EXCEPTION = "P0001";
const ORGANIZATION_CREDENTIAL_SCOPE_KEY = "__organization__";
const seededAt = "2026-01-01T00:00:00.000Z";
let client: Client;

interface ConfigRow {
  id: string;
  project_id: string;
  provider: string;
  status: string;
  updated_at: string;
}

interface PinnedConfigRow extends ConfigRow {
  project_environment: string;
}

interface ConnectionRow {
  id: string;
  project_id: string | null;
  scope: string;
  provider_credential_id: string;
  provider_credential_scope_key: string;
  default_custody_wallet_id: string | null;
  status: string;
  last_check_status: string | null;
  last_check_at: string | null;
  activated_at: string | null;
}

interface StoredConfigRow {
  id: string;
  organization_id: string;
  project_id: string;
  provider: string;
  config_encrypted: string;
  encryption_version: string;
  status: string;
  project_environment: string;
  created_at: string;
  updated_at: string;
}

async function restorePreDefaultsDropSchema(): Promise<void> {
  await restorePreCustodyDefaultsDropSchema(client);
  await client.query("DELETE FROM schema_migrations WHERE version = $1", [
    CUSTODY_DEFAULTS_DROP_MIGRATION,
  ]);
}

async function seedConfig(config: {
  id: string;
  organizationId: string;
  projectId: string;
  provider: CustodyProvider;
  status: CustodyConfigStatus;
}): Promise<void> {
  await client.query(
    `INSERT INTO custody_configs (
       id, organization_id, project_id, provider, config_encrypted, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'test-only', $5, $6, $6)`,
    [config.id, config.organizationId, config.projectId, config.provider, config.status, seededAt]
  );
}

async function seedConfigWallet(wallet: { id: string; custodyConfigId: string }): Promise<void> {
  await client.query(
    `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key)
     VALUES ($1, $2, $3, $4)`,
    [wallet.id, wallet.custodyConfigId, `${wallet.id}_provider`, `${wallet.id}_public_key`]
  );
}

async function seedScopeDefault(scopeDefault: {
  id: string;
  organizationId: string;
  projectId: string;
  custodyConfigId: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO custody_scope_defaults (
       id, organization_id, project_id, default_custody_config_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $5)`,
    [
      scopeDefault.id,
      scopeDefault.organizationId,
      scopeDefault.projectId,
      scopeDefault.custodyConfigId,
      seededAt,
    ]
  );
}

async function seedOrganizationCredential(credential: {
  id: string;
  organizationId: string;
  userId: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO provider_credentials (
       id, organization_id, project_id, provider, label, scope, source,
       storage_backend, encrypted_secret_payload, status, created_by
     ) VALUES ($1, $2, NULL, 'privy', $1, 'organization', 'stored',
               'encrypted_db', 'test-only', 'active', $3)`,
    [credential.id, credential.organizationId, credential.userId]
  );
}

async function seedConnection(connection: {
  id: string;
  organizationId: string;
  projectId: string | null;
  credentialId: string;
  credentialScopeKey: string;
  status: CustodyConnectionLifecycle;
  lastCheckStatus: CustodyConnectionCheckStatus | null;
  lastCheckAt: string | null;
  activatedAt: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO custody_connections (
       id, organization_id, project_id, provider, scope, provider_credential_id,
       provider_credential_scope_key, status, last_check_status, last_check_at, activated_at
     ) VALUES ($1, $2, $3, 'privy', $4, $5, $6, $7, $8, $9, $10)`,
    [
      connection.id,
      connection.organizationId,
      connection.projectId,
      connection.projectId === null ? "organization" : "project",
      connection.credentialId,
      connection.credentialScopeKey,
      connection.status,
      connection.lastCheckStatus,
      connection.lastCheckAt,
      connection.activatedAt,
    ]
  );
}

async function configsOf(organizationId: string): Promise<ConfigRow[]> {
  const result = await client.query<ConfigRow>(
    `SELECT id, project_id, provider, status, updated_at
       FROM custody_configs WHERE organization_id = $1 ORDER BY id`,
    [organizationId]
  );
  return result.rows;
}

async function pinnedConfigsOf(organizationId: string): Promise<PinnedConfigRow[]> {
  const result = await client.query<PinnedConfigRow>(
    `SELECT id, project_id, provider, status, project_environment, updated_at
       FROM custody_configs WHERE organization_id = $1 ORDER BY id`,
    [organizationId]
  );
  return result.rows;
}

async function connectionsOf(organizationId: string): Promise<ConnectionRow[]> {
  const result = await client.query<ConnectionRow>(
    `SELECT id, project_id, scope, provider_credential_id, provider_credential_scope_key,
            default_custody_wallet_id, status, last_check_status, last_check_at, activated_at
       FROM custody_connections WHERE organization_id = $1 ORDER BY id`,
    [organizationId]
  );
  return result.rows;
}

async function storedConfig(configId: string): Promise<StoredConfigRow[]> {
  const result = await client.query<StoredConfigRow>(
    `SELECT id, organization_id, project_id, provider, config_encrypted, encryption_version,
            status, project_environment, created_at, updated_at
       FROM custody_configs WHERE id = $1`,
    [configId]
  );
  return result.rows;
}

async function appliedDefaultsDrop(): Promise<{ version: string }[]> {
  const result = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations WHERE version = $1",
    [CUSTODY_DEFAULTS_DROP_MIGRATION]
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

describe("0126 drop custody defaults migration", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await restorePreDefaultsDropSchema();
  });

  afterEach(async () => {
    await seedTestDatabase(env);
    await runPostgresMigrations({ databaseUrl, migrationsDir });
  });

  it("drops custody_scope_defaults together with its rows", async () => {
    const tenant = await seedOrgProject(client, "0126_scope_defaults");
    await seedConfig({
      id: "ccfg_0126_scope_defaults",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "privy",
      status: "active",
    });
    await seedScopeDefault({
      id: "csd_0126_scope_defaults",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      custodyConfigId: "ccfg_0126_scope_defaults",
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    const relation = await client.query("SELECT to_regclass('custody_scope_defaults') AS relation");
    expect(relation.rows).toEqual([{ relation: null }]);
    expect(await appliedDefaultsDrop()).toEqual([{ version: CUSTODY_DEFAULTS_DROP_MIGRATION }]);
  });

  it("drops the config default wallet and its foreign key, and pins the config to its Sandbox project", async () => {
    const tenant = await seedOrgProject(client, "0126_default_wallet");
    await seedConfig({
      id: "ccfg_0126_default_wallet",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "privy",
      status: "active",
    });
    await seedConfigWallet({
      id: "cwal_0126_default_wallet",
      custodyConfigId: "ccfg_0126_default_wallet",
    });
    await client.query("UPDATE custody_configs SET default_wallet_id = $1 WHERE id = $2", [
      "cwal_0126_default_wallet_provider",
      "ccfg_0126_default_wallet",
    ]);

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    const column = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'custody_configs' AND column_name = 'default_wallet_id'`
    );
    expect(column.rows).toEqual([]);
    const constraint = await client.query(
      "SELECT conname FROM pg_constraint WHERE conname = 'custody_configs_default_wallet_fkey'"
    );
    expect(constraint.rows).toEqual([]);
    expect(await pinnedConfigsOf(tenant.organizationId)).toEqual([
      {
        id: "ccfg_0126_default_wallet",
        project_id: tenant.projectId,
        provider: "privy",
        status: "active",
        project_environment: "sandbox",
        updated_at: seededAt,
      },
    ]);
  });

  it("fails the migration and leaves it unrecorded when a custody config belongs to a Production project", async () => {
    const tenant = await seedOrgProject(client, "0126_production_guard");
    const productionProjectId = `${tenant.projectId}_production`;
    await seedConfig({
      id: "ccfg_0126_production_guard",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      provider: "privy",
      status: "active",
    });

    await expect(runPostgresMigrations({ databaseUrl, migrationsDir })).rejects.toMatchObject({
      code: RAISE_EXCEPTION,
      message: "1 custody config(s) belong to a Production project",
    });

    expect(await configsOf(tenant.organizationId)).toEqual([
      {
        id: "ccfg_0126_production_guard",
        project_id: productionProjectId,
        provider: "privy",
        status: "active",
        updated_at: seededAt,
      },
    ]);
    expect(await appliedDefaultsDrop()).toEqual([]);
  });

  it("fails the migration and leaves it unrecorded when a connection is not bound to a credential scoped to its own project", async () => {
    const tenant = await seedOrgProject(client, "0126_credential_guard");
    await seedOrganizationCredential({
      id: "pcred_0126_credential_guard",
      organizationId: tenant.organizationId,
      userId: tenant.userId,
    });
    await seedConnection({
      id: "cconn_0126_credential_guard",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      credentialId: "pcred_0126_credential_guard",
      credentialScopeKey: ORGANIZATION_CREDENTIAL_SCOPE_KEY,
      status: "pending",
      lastCheckStatus: null,
      lastCheckAt: null,
      activatedAt: null,
    });

    await expect(runPostgresMigrations({ databaseUrl, migrationsDir })).rejects.toMatchObject({
      code: RAISE_EXCEPTION,
      message: "1 custody connection(s) are not bound to a credential scoped to their own project",
    });

    expect(await connectionsOf(tenant.organizationId)).toEqual([
      {
        id: "cconn_0126_credential_guard",
        project_id: tenant.projectId,
        scope: "project",
        provider_credential_id: "pcred_0126_credential_guard",
        provider_credential_scope_key: ORGANIZATION_CREDENTIAL_SCOPE_KEY,
        default_custody_wallet_id: null,
        status: "pending",
        last_check_status: null,
        last_check_at: null,
        activated_at: null,
      },
    ]);
    expect(await appliedDefaultsDrop()).toEqual([]);
  });
});

describe("0126 drop custody defaults constraints", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await client.query("BEGIN");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("activates a connection without a default wallet while the rest of the active lifecycle still holds", async () => {
    const tenant = await seedOrgProject(client, "0126_lifecycle");
    await seedStoredProviderCredential(client, {
      id: "pcred_0126_lifecycle",
      label: "0126_lifecycle",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      userId: tenant.userId,
      provider: "privy",
    });
    await seedConnection({
      id: "cconn_0126_lifecycle_active",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      credentialId: "pcred_0126_lifecycle",
      credentialScopeKey: tenant.projectId,
      status: "active",
      lastCheckStatus: "success",
      lastCheckAt: seededAt,
      activatedAt: seededAt,
    });

    await expectSqlstate(
      client,
      () =>
        seedConnection({
          id: "cconn_0126_lifecycle_unchecked",
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          credentialId: "pcred_0126_lifecycle",
          credentialScopeKey: tenant.projectId,
          status: "active",
          lastCheckStatus: "success",
          lastCheckAt: null,
          activatedAt: seededAt,
        }),
      CHECK_VIOLATION
    );

    expect(await connectionsOf(tenant.organizationId)).toEqual([
      {
        id: "cconn_0126_lifecycle_active",
        project_id: tenant.projectId,
        scope: "project",
        provider_credential_id: "pcred_0126_lifecycle",
        provider_credential_scope_key: tenant.projectId,
        default_custody_wallet_id: null,
        status: "active",
        last_check_status: "success",
        last_check_at: seededAt,
        activated_at: seededAt,
      },
    ]);
  });

  it("rejects a custody config for a Production project and accepts one for a Sandbox project", async () => {
    const tenant = await seedOrgProject(client, "0126_environment");
    const productionProjectId = `${tenant.projectId}_production`;

    await expectSqlstate(
      client,
      () =>
        seedConfig({
          id: "ccfg_0126_environment_production",
          organizationId: tenant.organizationId,
          projectId: productionProjectId,
          provider: "privy",
          status: "active",
        }),
      FK_VIOLATION
    );
    await expectSqlstate(
      client,
      () =>
        client.query(
          `INSERT INTO custody_configs (
             id, organization_id, project_id, provider, config_encrypted, status, project_environment
           ) VALUES ('ccfg_0126_environment_explicit', $1, $2, 'privy', 'test-only', 'active', 'production')`,
          [tenant.organizationId, productionProjectId]
        ),
      CHECK_VIOLATION
    );
    await seedConfig({
      id: "ccfg_0126_environment_sandbox",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "privy",
      status: "active",
    });

    expect(await pinnedConfigsOf(tenant.organizationId)).toEqual([
      {
        id: "ccfg_0126_environment_sandbox",
        project_id: tenant.projectId,
        provider: "privy",
        status: "active",
        project_environment: "sandbox",
        updated_at: seededAt,
      },
    ]);
  });

  it("refuses to switch a project that holds a custody config to Production", async () => {
    const tenant = await seedOrgProject(client, "0126_switch");
    await seedConfig({
      id: "ccfg_0126_switch",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "privy",
      status: "active",
    });
    await client.query("UPDATE projects SET status = 'archived' WHERE id = $1", [
      `${tenant.projectId}_production`,
    ]);

    await expectSqlstate(
      client,
      () =>
        client.query("UPDATE projects SET environment = 'production' WHERE id = $1", [
          tenant.projectId,
        ]),
      FK_VIOLATION
    );
  });

  it("rejects an organization-scope connection and a project connection bound to an organization credential", async () => {
    const tenant = await seedOrgProject(client, "0126_credential_scope");
    await seedOrganizationCredential({
      id: "pcred_0126_credential_scope",
      organizationId: tenant.organizationId,
      userId: tenant.userId,
    });

    await expectSqlstate(
      client,
      () =>
        seedConnection({
          id: "cconn_0126_credential_scope_organization",
          organizationId: tenant.organizationId,
          projectId: null,
          credentialId: "pcred_0126_credential_scope",
          credentialScopeKey: ORGANIZATION_CREDENTIAL_SCOPE_KEY,
          status: "pending",
          lastCheckStatus: null,
          lastCheckAt: null,
          activatedAt: null,
        }),
      CHECK_VIOLATION
    );
    await expectSqlstate(
      client,
      () =>
        seedConnection({
          id: "cconn_0126_credential_scope_project",
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          credentialId: "pcred_0126_credential_scope",
          credentialScopeKey: ORGANIZATION_CREDENTIAL_SCOPE_KEY,
          status: "pending",
          lastCheckStatus: null,
          lastCheckAt: null,
          activatedAt: null,
        }),
      CHECK_VIOLATION
    );

    expect(await connectionsOf(tenant.organizationId)).toEqual([]);
  });
});

describe("0126 custody config re-initialization after archive", () => {
  let originalCustodyEncryptionKey: string | undefined;

  beforeEach(async () => {
    originalCustodyEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    await seedTestDatabase(env);
  });

  afterEach(() => {
    env.CUSTODY_ENCRYPTION_KEY = originalCustodyEncryptionKey;
  });

  it("inserts a new config and leaves the archived one unchanged", async () => {
    const tenant = await seedOrgProject(client, "0126_reinitialize");
    const store = new CustodyConfigStore(getDb(env), env);
    const configInput: Parameters<CustodyConfigStore["saveProviderConfig"]>[0] = {
      orgId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "privy",
      configJson: { provider: "privy", privyAppId: "app_0126_reinitialize" },
    };
    const archived = await store.saveProviderConfig(configInput);
    await client.query(
      "UPDATE custody_configs SET status = 'archived', updated_at = $2 WHERE id = $1",
      [archived.configId, seededAt]
    );
    const archivedRows = await storedConfig(archived.configId);
    expect(archivedRows).toEqual([
      {
        id: archived.configId,
        organization_id: tenant.organizationId,
        project_id: tenant.projectId,
        provider: "privy",
        config_encrypted: expect.any(String),
        encryption_version: expect.any(String),
        status: "archived",
        project_environment: "sandbox",
        created_at: expect.any(String),
        updated_at: seededAt,
      },
    ]);

    const reinitialized = await store.saveProviderConfig(configInput);

    expect(reinitialized.configId).not.toBe(archived.configId);
    expect(await storedConfig(archived.configId)).toEqual(archivedRows);
    expect(await storedConfig(reinitialized.configId)).toEqual([
      {
        id: reinitialized.configId,
        organization_id: tenant.organizationId,
        project_id: tenant.projectId,
        provider: "privy",
        config_encrypted: expect.any(String),
        encryption_version: expect.any(String),
        status: "active",
        project_environment: "sandbox",
        created_at: expect.any(String),
        updated_at: expect.any(String),
      },
    ]);
  });
});
