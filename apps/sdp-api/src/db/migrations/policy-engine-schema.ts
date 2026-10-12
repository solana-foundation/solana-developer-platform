import type { Client } from "pg";

/** The migration that drops the custody policy engine tables. */
export const POLICY_ENGINE_DROP_MIGRATION = "0128_drop_policy_engine_tables.sql";

/**
 * Recreates the policy tables that `0125_custody_project_only.sql` locks and
 * rewrites, in their pre-0128 shape, so a test can re-apply that migration. The
 * 0128 `schema_migrations` row is left in place, so a caller that re-runs
 * migrations deletes it afterwards to drop these tables again.
 *
 * Row-level security is not recreated: the callers use an admin connection that
 * does not exercise it.
 *
 * @param client - Admin connection the DDL runs on.
 * @returns Resolves once the tables exist and are empty.
 */
export async function restorePolicyEngineTablesForMigration0125(client: Client): Promise<void> {
  await client.query(
    [
      `CREATE TABLE approval_groups (
         id TEXT PRIMARY KEY,
         organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
         project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
         name TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'active'
           CONSTRAINT approval_groups_status_check CHECK (status IN ('active', 'archived')),
         created_by TEXT,
         created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
         updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
         archived_at TEXT
       )`,
      `CREATE INDEX idx_approval_groups_org_project ON approval_groups(organization_id, project_id)`,
      `CREATE TABLE approval_group_members (
         id TEXT PRIMARY KEY,
         approval_group_id TEXT NOT NULL REFERENCES approval_groups(id) ON DELETE CASCADE,
         user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         role TEXT NOT NULL DEFAULT 'approver',
         created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
         UNIQUE (approval_group_id, user_id)
       )`,
      `CREATE INDEX idx_approval_group_members_group ON approval_group_members(approval_group_id)`,
      `CREATE TABLE wallet_control_profiles (
         id TEXT PRIMARY KEY,
         organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
         project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
         custody_wallet_id TEXT NOT NULL REFERENCES custody_wallets(id) ON DELETE CASCADE,
         name TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'draft'
           CONSTRAINT wallet_control_profiles_status_check
             CHECK (status IN ('draft', 'active', 'disabled', 'archived')),
         active_revision_id TEXT,
         created_by TEXT,
         created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
         updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
         activated_at TEXT,
         archived_at TEXT
       )`,
      `CREATE UNIQUE INDEX idx_wallet_control_profiles_active_wallet
         ON wallet_control_profiles(custody_wallet_id) WHERE status = 'active'`,
      `CREATE INDEX idx_wallet_control_profiles_org_project
         ON wallet_control_profiles(organization_id, project_id)`,
      `CREATE INDEX idx_wallet_control_profiles_wallet ON wallet_control_profiles(custody_wallet_id)`,
      `CREATE TABLE wallet_control_profile_revisions (
         id TEXT PRIMARY KEY,
         profile_id TEXT NOT NULL REFERENCES wallet_control_profiles(id) ON DELETE CASCADE,
         revision_number INTEGER NOT NULL,
         rules JSONB NOT NULL DEFAULT '[]'::jsonb,
         default_action TEXT NOT NULL DEFAULT 'allow'
           CONSTRAINT wallet_control_profile_revisions_action_check
             CHECK (default_action IN ('allow', 'deny', 'approval_required', 'review')),
         created_by TEXT,
         created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
         activated_at TEXT,
         commit_message TEXT,
         UNIQUE (profile_id, revision_number)
       )`,
      `CREATE INDEX idx_wallet_control_profile_revisions_profile
         ON wallet_control_profile_revisions(profile_id, revision_number DESC)`,
      `CREATE TABLE api_key_control_profiles (
         id TEXT PRIMARY KEY,
         organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
         project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
         api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
         name TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'draft'
           CONSTRAINT api_key_control_profiles_status_check
             CHECK (status IN ('draft', 'active', 'disabled', 'archived')),
         active_revision_id TEXT,
         created_by TEXT,
         created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
         updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
         activated_at TEXT,
         archived_at TEXT
       )`,
      `CREATE INDEX idx_api_key_control_profiles_key ON api_key_control_profiles(api_key_id)`,
      `CREATE INDEX idx_api_key_control_profiles_org_project
         ON api_key_control_profiles(organization_id, project_id)`,
      `CREATE TABLE api_key_control_profile_revisions (
         id TEXT PRIMARY KEY,
         profile_id TEXT NOT NULL REFERENCES api_key_control_profiles(id) ON DELETE CASCADE,
         revision_number INTEGER NOT NULL,
         rules JSONB NOT NULL DEFAULT '[]'::jsonb,
         default_action TEXT NOT NULL DEFAULT 'allow'
           CONSTRAINT api_key_control_profile_revisions_action_check
             CHECK (default_action IN ('allow', 'deny', 'approval_required', 'review')),
         created_by TEXT,
         created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
         activated_at TEXT,
         UNIQUE (profile_id, revision_number)
       )`,
      `CREATE INDEX idx_api_key_control_profile_revisions_profile
         ON api_key_control_profile_revisions(profile_id, revision_number DESC)`,
    ].join(";\n")
  );
}
