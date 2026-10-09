import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalPolicyRule, CustodyConfigStatus, CustodyProvider } from "@sdp/types";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl as databaseUrl, env } from "@/test/helpers/env";
import {
  CHECK_VIOLATION,
  expectSqlstate,
  NOT_NULL_VIOLATION,
  seedOrgProject,
  UNIQUE_VIOLATION,
} from "@/test/helpers/migration-db";
import { seedTestDatabase } from "@/test/mocks/db";
import { runPostgresMigrations } from "../../../scripts/lib/run-postgres-migrations.mjs";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const migrationFile = "0125_custody_project_only.sql";
const RAISE_EXCEPTION = "P0001";
const seededAt = "2026-01-01T00:00:00.000Z";
let client: Client;

interface ConfigRow {
  id: string;
  project_id: string | null;
  provider: string;
  status: string;
  updated_at: string;
}

interface ScopeDefaultRow {
  id: string;
  project_id: string | null;
  default_custody_config_id: string;
  updated_at: string;
}

interface WalletScopeRow {
  id: string;
  custody_config_id: string;
  project_id: string;
  config_status: string;
}

interface ProfileRow {
  id: string;
  project_id: string | null;
  custody_wallet_id: string;
}

interface ApprovalGroupRow {
  id: string;
  project_id: string | null;
  member_user_ids: string[];
}

async function restorePreProjectOnlySchema(): Promise<void> {
  await client.query(
    [
      "DROP INDEX idx_custody_scope_defaults_org_project",
      `CREATE UNIQUE INDEX idx_custody_scope_defaults_org_project_not_null
         ON custody_scope_defaults(organization_id, project_id)
         WHERE project_id IS NOT NULL`,
      `CREATE UNIQUE INDEX idx_custody_scope_defaults_org_null_project
         ON custody_scope_defaults(organization_id)
         WHERE project_id IS NULL`,
      `ALTER TABLE custody_scope_defaults
         ALTER COLUMN project_id DROP NOT NULL,
         ADD CONSTRAINT custody_scope_defaults_connection_project_only
           CHECK (default_custody_connection_id IS NULL OR project_id IS NOT NULL)`,
      "DROP INDEX idx_custody_configs_org_project_provider_unarchived",
      `ALTER TABLE custody_configs
         ALTER COLUMN project_id DROP NOT NULL,
         DROP CONSTRAINT custody_configs_status_check,
         ADD CONSTRAINT custody_configs_org_project_provider_key
           UNIQUE NULLS NOT DISTINCT (organization_id, project_id, provider)`,
      `DELETE FROM schema_migrations WHERE version = '${migrationFile}'`,
    ].join(";\n")
  );
}

async function seedConfig(config: {
  id: string;
  organizationId: string;
  projectId: string | null;
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

async function seedWallet(wallet: { id: string; custodyConfigId: string }): Promise<void> {
  await client.query(
    `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key)
     VALUES ($1, $2, $3, $4)`,
    [wallet.id, wallet.custodyConfigId, `${wallet.id}_provider`, `${wallet.id}_public_key`]
  );
}

async function seedScopeDefault(scopeDefault: {
  id: string;
  organizationId: string;
  projectId: string | null;
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

async function seedActiveProfile(profile: {
  id: string;
  organizationId: string;
  projectId: string | null;
  custodyWalletId: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO wallet_control_profiles (
       id, organization_id, project_id, custody_wallet_id, name, status
     ) VALUES ($1, $2, $3, $4, $1, 'active')`,
    [profile.id, profile.organizationId, profile.projectId, profile.custodyWalletId]
  );
}

async function seedProfileRevision(revision: {
  id: string;
  profileId: string;
  approvalGroupId: string;
}): Promise<void> {
  const rules: ApprovalPolicyRule[] = [
    { kind: "approval", families: ["transfer"], approvalGroupId: revision.approvalGroupId },
  ];
  await client.query(
    `INSERT INTO wallet_control_profile_revisions (id, profile_id, revision_number, rules)
     VALUES ($1, $2, 1, $3)`,
    [revision.id, revision.profileId, JSON.stringify(rules)]
  );
}

async function seedApprovalGroup(group: {
  id: string;
  organizationId: string;
  projectId: string | null;
  memberUserId: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO approval_groups (id, organization_id, project_id, name)
     VALUES ($1, $2, $3, $1)`,
    [group.id, group.organizationId, group.projectId]
  );
  await client.query(
    `INSERT INTO approval_group_members (id, approval_group_id, user_id)
     VALUES ($1, $2, $3)`,
    [`${group.id}_member`, group.id, group.memberUserId]
  );
}

async function approvalGroupsOf(organizationId: string): Promise<ApprovalGroupRow[]> {
  const result = await client.query<ApprovalGroupRow>(
    `SELECT grp.id,
            grp.project_id,
            ARRAY_AGG(member.user_id ORDER BY member.user_id) AS member_user_ids
       FROM approval_groups grp
       JOIN approval_group_members member ON member.approval_group_id = grp.id
      WHERE grp.organization_id = $1
      GROUP BY grp.id, grp.project_id
      ORDER BY grp.id`,
    [organizationId]
  );
  return result.rows;
}

async function recordedMigrations(): Promise<unknown[]> {
  const result = await client.query("SELECT version FROM schema_migrations WHERE version = $1", [
    migrationFile,
  ]);
  return result.rows;
}

async function configsOf(organizationId: string): Promise<ConfigRow[]> {
  const result = await client.query<ConfigRow>(
    `SELECT id, project_id, provider, status, updated_at
       FROM custody_configs WHERE organization_id = $1 ORDER BY id`,
    [organizationId]
  );
  return result.rows;
}

async function scopeDefaultsOf(organizationId: string): Promise<ScopeDefaultRow[]> {
  const result = await client.query<ScopeDefaultRow>(
    `SELECT id, project_id, default_custody_config_id, updated_at
       FROM custody_scope_defaults WHERE organization_id = $1 ORDER BY id`,
    [organizationId]
  );
  return result.rows;
}

async function walletScopesOf(organizationId: string): Promise<WalletScopeRow[]> {
  const result = await client.query<WalletScopeRow>(
    `SELECT wallet.id, wallet.custody_config_id, config.project_id, config.status AS config_status
       FROM custody_wallets wallet
       JOIN custody_configs config ON config.id = wallet.custody_config_id
      WHERE config.organization_id = $1
      ORDER BY wallet.id`,
    [organizationId]
  );
  return result.rows;
}

async function profilesOf(organizationId: string): Promise<ProfileRow[]> {
  const result = await client.query<ProfileRow>(
    `SELECT id, project_id, custody_wallet_id
       FROM wallet_control_profiles WHERE organization_id = $1 ORDER BY id`,
    [organizationId]
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

describe("0125 custody project-only migration", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await restorePreProjectOnlySchema();
  });

  afterEach(async () => {
    await seedTestDatabase(env);
    await runPostgresMigrations({ databaseUrl, migrationsDir });
  });

  it("moves an org-level config and its default into the Sandbox project, and its wallets resolve under it", async () => {
    const tenant = await seedOrgProject(client, "0125_move");
    await seedConfig({
      id: "ccfg_0125_move",
      organizationId: tenant.organizationId,
      projectId: null,
      provider: "privy",
      status: "active",
    });
    await seedWallet({ id: "cwal_0125_move", custodyConfigId: "ccfg_0125_move" });
    await seedScopeDefault({
      id: "csd_0125_move",
      organizationId: tenant.organizationId,
      projectId: null,
      custodyConfigId: "ccfg_0125_move",
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await configsOf(tenant.organizationId)).toEqual([
      {
        id: "ccfg_0125_move",
        project_id: tenant.projectId,
        provider: "privy",
        status: "active",
        updated_at: seededAt,
      },
    ]);
    expect(await scopeDefaultsOf(tenant.organizationId)).toEqual([
      {
        id: "csd_0125_move",
        project_id: tenant.projectId,
        default_custody_config_id: "ccfg_0125_move",
        updated_at: seededAt,
      },
    ]);
    expect(await walletScopesOf(tenant.organizationId)).toEqual([
      {
        id: "cwal_0125_move",
        custody_config_id: "ccfg_0125_move",
        project_id: tenant.projectId,
        config_status: "active",
      },
    ]);
  });

  it("archives an org-level config into the Sandbox project when Sandbox holds an active config for the provider", async () => {
    const tenant = await seedOrgProject(client, "0125_active");
    await seedConfig({
      id: "ccfg_0125_active_org",
      organizationId: tenant.organizationId,
      projectId: null,
      provider: "privy",
      status: "active",
    });
    await seedWallet({ id: "cwal_0125_active_org", custodyConfigId: "ccfg_0125_active_org" });
    await seedConfig({
      id: "ccfg_0125_active_sandbox",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "privy",
      status: "active",
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await configsOf(tenant.organizationId)).toEqual([
      {
        id: "ccfg_0125_active_org",
        project_id: tenant.projectId,
        provider: "privy",
        status: "archived",
        updated_at: expect.not.stringContaining(seededAt),
      },
      {
        id: "ccfg_0125_active_sandbox",
        project_id: tenant.projectId,
        provider: "privy",
        status: "active",
        updated_at: seededAt,
      },
    ]);
    expect(await walletScopesOf(tenant.organizationId)).toEqual([
      {
        id: "cwal_0125_active_org",
        custody_config_id: "ccfg_0125_active_org",
        project_id: tenant.projectId,
        config_status: "archived",
      },
    ]);
  });

  it("archives an org-level config into the Sandbox project when Sandbox holds an inactive config for the provider", async () => {
    const tenant = await seedOrgProject(client, "0125_inactive");
    await seedConfig({
      id: "ccfg_0125_inactive_org",
      organizationId: tenant.organizationId,
      projectId: null,
      provider: "privy",
      status: "active",
    });
    await seedConfig({
      id: "ccfg_0125_inactive_sandbox",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "privy",
      status: "inactive",
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await configsOf(tenant.organizationId)).toEqual([
      {
        id: "ccfg_0125_inactive_org",
        project_id: tenant.projectId,
        provider: "privy",
        status: "archived",
        updated_at: expect.not.stringContaining(seededAt),
      },
      {
        id: "ccfg_0125_inactive_sandbox",
        project_id: tenant.projectId,
        provider: "privy",
        status: "inactive",
        updated_at: seededAt,
      },
    ]);
  });

  it("moves an org-level config with its status unchanged when the Sandbox config for the provider is archived", async () => {
    const tenant = await seedOrgProject(client, "0125_archived");
    await seedConfig({
      id: "ccfg_0125_archived_org",
      organizationId: tenant.organizationId,
      projectId: null,
      provider: "privy",
      status: "active",
    });
    await seedConfig({
      id: "ccfg_0125_archived_sandbox",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "privy",
      status: "archived",
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await configsOf(tenant.organizationId)).toEqual([
      {
        id: "ccfg_0125_archived_org",
        project_id: tenant.projectId,
        provider: "privy",
        status: "active",
        updated_at: seededAt,
      },
      {
        id: "ccfg_0125_archived_sandbox",
        project_id: tenant.projectId,
        provider: "privy",
        status: "archived",
        updated_at: seededAt,
      },
    ]);
  });

  it("deletes an org-level default when the Sandbox project already has a default", async () => {
    const tenant = await seedOrgProject(client, "0125_default_collision");
    await seedConfig({
      id: "ccfg_0125_default_collision_org",
      organizationId: tenant.organizationId,
      projectId: null,
      provider: "privy",
      status: "active",
    });
    await seedScopeDefault({
      id: "csd_0125_default_collision_org",
      organizationId: tenant.organizationId,
      projectId: null,
      custodyConfigId: "ccfg_0125_default_collision_org",
    });
    await seedConfig({
      id: "ccfg_0125_default_collision_sandbox",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "fireblocks",
      status: "active",
    });
    await seedScopeDefault({
      id: "csd_0125_default_collision_sandbox",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      custodyConfigId: "ccfg_0125_default_collision_sandbox",
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await scopeDefaultsOf(tenant.organizationId)).toEqual([
      {
        id: "csd_0125_default_collision_sandbox",
        project_id: tenant.projectId,
        default_custody_config_id: "ccfg_0125_default_collision_sandbox",
        updated_at: seededAt,
      },
    ]);
    expect(await configsOf(tenant.organizationId)).toEqual([
      {
        id: "ccfg_0125_default_collision_org",
        project_id: tenant.projectId,
        provider: "privy",
        status: "active",
        updated_at: seededAt,
      },
      {
        id: "ccfg_0125_default_collision_sandbox",
        project_id: tenant.projectId,
        provider: "fireblocks",
        status: "active",
        updated_at: seededAt,
      },
    ]);
  });

  it("repoints a moved default that selected an archived config to the Sandbox config it collided with", async () => {
    const tenant = await seedOrgProject(client, "0125_repoint");
    await seedConfig({
      id: "ccfg_0125_repoint_org",
      organizationId: tenant.organizationId,
      projectId: null,
      provider: "privy",
      status: "active",
    });
    await seedScopeDefault({
      id: "csd_0125_repoint",
      organizationId: tenant.organizationId,
      projectId: null,
      custodyConfigId: "ccfg_0125_repoint_org",
    });
    await seedConfig({
      id: "ccfg_0125_repoint_sandbox",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "privy",
      status: "active",
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await scopeDefaultsOf(tenant.organizationId)).toEqual([
      {
        id: "csd_0125_repoint",
        project_id: tenant.projectId,
        default_custody_config_id: "ccfg_0125_repoint_sandbox",
        updated_at: expect.not.stringContaining(seededAt),
      },
    ]);
  });

  it("repoints the control profiles of moved wallets to the Sandbox project and leaves other wallets' profiles in place", async () => {
    const tenant = await seedOrgProject(client, "0125_profiles");
    const productionProjectId = `${tenant.projectId}_production`;
    await seedConfig({
      id: "ccfg_0125_profiles_org",
      organizationId: tenant.organizationId,
      projectId: null,
      provider: "privy",
      status: "active",
    });
    await seedWallet({
      id: "cwal_0125_profiles_production",
      custodyConfigId: "ccfg_0125_profiles_org",
    });
    await seedWallet({
      id: "cwal_0125_profiles_unscoped",
      custodyConfigId: "ccfg_0125_profiles_org",
    });
    await seedConfig({
      id: "ccfg_0125_profiles_sandbox",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "fireblocks",
      status: "active",
    });
    await seedWallet({
      id: "cwal_0125_profiles_sandbox",
      custodyConfigId: "ccfg_0125_profiles_sandbox",
    });
    await seedActiveProfile({
      id: "wcp_0125_profiles_production",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      custodyWalletId: "cwal_0125_profiles_production",
    });
    await seedActiveProfile({
      id: "wcp_0125_profiles_unscoped",
      organizationId: tenant.organizationId,
      projectId: null,
      custodyWalletId: "cwal_0125_profiles_unscoped",
    });
    await seedActiveProfile({
      id: "wcp_0125_profiles_untouched",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      custodyWalletId: "cwal_0125_profiles_sandbox",
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await profilesOf(tenant.organizationId)).toEqual([
      {
        id: "wcp_0125_profiles_production",
        project_id: tenant.projectId,
        custody_wallet_id: "cwal_0125_profiles_production",
      },
      {
        id: "wcp_0125_profiles_unscoped",
        project_id: tenant.projectId,
        custody_wallet_id: "cwal_0125_profiles_unscoped",
      },
      {
        id: "wcp_0125_profiles_untouched",
        project_id: productionProjectId,
        custody_wallet_id: "cwal_0125_profiles_sandbox",
      },
    ]);
  });

  it("fails the migration and moves nothing when an organization with org-level custody has no active Sandbox project", async () => {
    const tenant = await seedOrgProject(client, "0125_guard");
    await client.query("UPDATE projects SET status = 'archived' WHERE id = $1", [tenant.projectId]);
    await seedConfig({
      id: "ccfg_0125_guard",
      organizationId: tenant.organizationId,
      projectId: null,
      provider: "privy",
      status: "active",
    });

    await expect(runPostgresMigrations({ databaseUrl, migrationsDir })).rejects.toMatchObject({
      code: RAISE_EXCEPTION,
      message:
        "1 org-level custody row(s) belong to an organization with no active Sandbox project",
    });

    expect(await configsOf(tenant.organizationId)).toEqual([
      {
        id: "ccfg_0125_guard",
        project_id: null,
        provider: "privy",
        status: "active",
        updated_at: seededAt,
      },
    ]);
    expect(await recordedMigrations()).toEqual([]);
  });

  it("moves an org-level approval group a moved profile names into the Sandbox project with its members", async () => {
    const tenant = await seedOrgProject(client, "0125_group_move");
    await seedConfig({
      id: "ccfg_0125_group_move",
      organizationId: tenant.organizationId,
      projectId: null,
      provider: "privy",
      status: "active",
    });
    await seedWallet({ id: "cwal_0125_group_move", custodyConfigId: "ccfg_0125_group_move" });
    await seedActiveProfile({
      id: "wcp_0125_group_move",
      organizationId: tenant.organizationId,
      projectId: null,
      custodyWalletId: "cwal_0125_group_move",
    });
    await seedProfileRevision({
      id: "wcpr_0125_group_move",
      profileId: "wcp_0125_group_move",
      approvalGroupId: "apg_0125_group_move",
    });
    await seedApprovalGroup({
      id: "apg_0125_group_move",
      organizationId: tenant.organizationId,
      projectId: null,
      memberUserId: tenant.userId,
    });
    await seedApprovalGroup({
      id: "apg_0125_group_move_unnamed",
      organizationId: tenant.organizationId,
      projectId: null,
      memberUserId: tenant.userId,
    });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect(await approvalGroupsOf(tenant.organizationId)).toEqual([
      {
        id: "apg_0125_group_move",
        project_id: tenant.projectId,
        member_user_ids: [tenant.userId],
      },
      {
        id: "apg_0125_group_move_unnamed",
        project_id: null,
        member_user_ids: [tenant.userId],
      },
    ]);
    expect(await profilesOf(tenant.organizationId)).toEqual([
      {
        id: "wcp_0125_group_move",
        project_id: tenant.projectId,
        custody_wallet_id: "cwal_0125_group_move",
      },
    ]);
  });

  it("fails the migration and moves nothing when a moved profile names an approval group in another project", async () => {
    const tenant = await seedOrgProject(client, "0125_group_foreign");
    const productionProjectId = `${tenant.projectId}_production`;
    await seedConfig({
      id: "ccfg_0125_group_foreign",
      organizationId: tenant.organizationId,
      projectId: null,
      provider: "privy",
      status: "active",
    });
    await seedWallet({ id: "cwal_0125_group_foreign", custodyConfigId: "ccfg_0125_group_foreign" });
    await seedActiveProfile({
      id: "wcp_0125_group_foreign",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      custodyWalletId: "cwal_0125_group_foreign",
    });
    await seedProfileRevision({
      id: "wcpr_0125_group_foreign",
      profileId: "wcp_0125_group_foreign",
      approvalGroupId: "apg_0125_group_foreign",
    });
    await seedApprovalGroup({
      id: "apg_0125_group_foreign",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      memberUserId: tenant.userId,
    });

    await expect(runPostgresMigrations({ databaseUrl, migrationsDir })).rejects.toMatchObject({
      code: RAISE_EXCEPTION,
      message: "1 approval group(s) named by moved custody profiles belong to another project",
    });

    expect(await approvalGroupsOf(tenant.organizationId)).toEqual([
      {
        id: "apg_0125_group_foreign",
        project_id: productionProjectId,
        member_user_ids: [tenant.userId],
      },
    ]);
    expect(await profilesOf(tenant.organizationId)).toEqual([
      {
        id: "wcp_0125_group_foreign",
        project_id: productionProjectId,
        custody_wallet_id: "cwal_0125_group_foreign",
      },
    ]);
    expect(await recordedMigrations()).toEqual([]);
  });

  it("fails the migration and moves nothing when a profile staying outside the Sandbox project names the same org-level approval group", async () => {
    const tenant = await seedOrgProject(client, "0125_group_shared");
    const productionProjectId = `${tenant.projectId}_production`;
    await seedConfig({
      id: "ccfg_0125_group_shared_org",
      organizationId: tenant.organizationId,
      projectId: null,
      provider: "privy",
      status: "active",
    });
    await seedWallet({
      id: "cwal_0125_group_shared_moved",
      custodyConfigId: "ccfg_0125_group_shared_org",
    });
    await seedConfig({
      id: "ccfg_0125_group_shared_sandbox",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "fireblocks",
      status: "active",
    });
    await seedWallet({
      id: "cwal_0125_group_shared_staying",
      custodyConfigId: "ccfg_0125_group_shared_sandbox",
    });
    await seedActiveProfile({
      id: "wcp_0125_group_shared_moved",
      organizationId: tenant.organizationId,
      projectId: null,
      custodyWalletId: "cwal_0125_group_shared_moved",
    });
    await seedProfileRevision({
      id: "wcpr_0125_group_shared_moved",
      profileId: "wcp_0125_group_shared_moved",
      approvalGroupId: "apg_0125_group_shared",
    });
    await seedActiveProfile({
      id: "wcp_0125_group_shared_staying",
      organizationId: tenant.organizationId,
      projectId: productionProjectId,
      custodyWalletId: "cwal_0125_group_shared_staying",
    });
    await seedProfileRevision({
      id: "wcpr_0125_group_shared_staying",
      profileId: "wcp_0125_group_shared_staying",
      approvalGroupId: "apg_0125_group_shared",
    });
    await seedApprovalGroup({
      id: "apg_0125_group_shared",
      organizationId: tenant.organizationId,
      projectId: null,
      memberUserId: tenant.userId,
    });

    await expect(runPostgresMigrations({ databaseUrl, migrationsDir })).rejects.toMatchObject({
      code: RAISE_EXCEPTION,
      message:
        "1 org-level approval group(s) named by moved custody profiles are also named by profiles outside the Sandbox project",
    });

    expect(await approvalGroupsOf(tenant.organizationId)).toEqual([
      {
        id: "apg_0125_group_shared",
        project_id: null,
        member_user_ids: [tenant.userId],
      },
    ]);
    expect(await profilesOf(tenant.organizationId)).toEqual([
      {
        id: "wcp_0125_group_shared_moved",
        project_id: null,
        custody_wallet_id: "cwal_0125_group_shared_moved",
      },
      {
        id: "wcp_0125_group_shared_staying",
        project_id: productionProjectId,
        custody_wallet_id: "cwal_0125_group_shared_staying",
      },
    ]);
    expect(await recordedMigrations()).toEqual([]);
  });
});

describe("0125 custody project-only constraints", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await client.query("BEGIN");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("rejects an org-level custody config and an org-level custody default", async () => {
    const tenant = await seedOrgProject(client, "0125_not_null");
    await seedConfig({
      id: "ccfg_0125_not_null",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "privy",
      status: "active",
    });

    await expectSqlstate(
      client,
      () =>
        seedConfig({
          id: "ccfg_0125_not_null_org",
          organizationId: tenant.organizationId,
          projectId: null,
          provider: "fireblocks",
          status: "active",
        }),
      NOT_NULL_VIOLATION
    );
    await expectSqlstate(
      client,
      () =>
        seedScopeDefault({
          id: "csd_0125_not_null_org",
          organizationId: tenant.organizationId,
          projectId: null,
          custodyConfigId: "ccfg_0125_not_null",
        }),
      NOT_NULL_VIOLATION
    );
  });

  it("rejects a custody config status outside the config lifecycle", async () => {
    const tenant = await seedOrgProject(client, "0125_status");

    await expectSqlstate(
      client,
      () =>
        client.query(
          `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
           VALUES ('ccfg_0125_status', $1, $2, 'privy', 'test-only', 'deleted')`,
          [tenant.organizationId, tenant.projectId]
        ),
      CHECK_VIOLATION
    );
  });

  it("allows one unarchived config per project and provider while archived duplicates insert", async () => {
    const tenant = await seedOrgProject(client, "0125_unique");
    await seedConfig({
      id: "ccfg_0125_unique_active",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "privy",
      status: "active",
    });

    await expectSqlstate(
      client,
      () =>
        seedConfig({
          id: "ccfg_0125_unique_duplicate",
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          provider: "privy",
          status: "active",
        }),
      UNIQUE_VIOLATION
    );
    await seedConfig({
      id: "ccfg_0125_unique_archived",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      provider: "privy",
      status: "archived",
    });

    expect(await configsOf(tenant.organizationId)).toEqual([
      {
        id: "ccfg_0125_unique_active",
        project_id: tenant.projectId,
        provider: "privy",
        status: "active",
        updated_at: seededAt,
      },
      {
        id: "ccfg_0125_unique_archived",
        project_id: tenant.projectId,
        provider: "privy",
        status: "archived",
        updated_at: seededAt,
      },
    ]);
  });
});
