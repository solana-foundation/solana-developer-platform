import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { env } from "@/test/helpers/env";

it("deduplicates org-level custody configs and repoints references", async () => {
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0056_custody_config_scope_integrity.sql"
  );
  const sql = readFileSync(migrationPath, "utf8");
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  const notices: string[] = [];
  client.on("notice", (notice) => {
    if (notice.message) notices.push(notice.message);
  });

  try {
    await client.query("BEGIN");
    // Temp tables shadow the real ones on the search path, mirroring the
    // pre-0056 schema (plain UNIQUE constraint, cascade wallet ownership).
    await client.query(`CREATE TEMP TABLE custody_configs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      provider TEXT NOT NULL,
      config_encrypted TEXT NOT NULL DEFAULT 'enc',
      encryption_version TEXT NOT NULL DEFAULT 'test',
      default_wallet_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL,
      CONSTRAINT custody_configs_organization_id_project_id_provider_key
        UNIQUE (organization_id, project_id, provider)
    )`);
    await client.query(`CREATE TEMP TABLE custody_wallets (
      id TEXT PRIMARY KEY,
      custody_config_id TEXT REFERENCES custody_configs(id) ON DELETE CASCADE,
      wallet_id TEXT NOT NULL,
      public_key TEXT NOT NULL DEFAULT 'pub',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      CONSTRAINT custody_wallets_custody_config_id_wallet_id_key
        UNIQUE (custody_config_id, wallet_id)
    )`);
    await client.query(`CREATE TEMP TABLE custody_scope_defaults (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      default_custody_config_id TEXT REFERENCES custody_configs(id)
    )`);
    await client.query(`CREATE TEMP TABLE signing_requests (
      id TEXT PRIMARY KEY,
      custody_config_id TEXT REFERENCES custody_configs(id) ON DELETE SET NULL
    )`);
    await client.query(`CREATE TEMP TABLE wallet_control_profiles (
      id TEXT PRIMARY KEY,
      custody_wallet_id TEXT NOT NULL REFERENCES custody_wallets(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'draft',
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE UNIQUE INDEX idx_wallet_control_profiles_active_wallet_shadow
      ON wallet_control_profiles(custody_wallet_id)
      WHERE status = 'active'`);
    await client.query(`CREATE TEMP TABLE api_key_wallet_policy_bindings (
      id TEXT PRIMARY KEY,
      api_key_id TEXT NOT NULL,
      binding_scope TEXT NOT NULL DEFAULT 'selected',
      wallet_id TEXT,
      custody_wallet_id TEXT REFERENCES custody_wallets(id) ON DELETE SET NULL,
      wallet_control_profile_id TEXT REFERENCES wallet_control_profiles(id) ON DELETE SET NULL,
      api_key_control_profile_id TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      CONSTRAINT api_key_wallet_policy_bindings_wallet_check_shadow CHECK (
        binding_scope <> 'selected'
        OR (wallet_id IS NOT NULL AND custody_wallet_id IS NOT NULL)
      )
    )`);
    await client.query(`CREATE UNIQUE INDEX idx_api_key_wallet_policy_bindings_selected_shadow
      ON api_key_wallet_policy_bindings(api_key_id, custody_wallet_id)
      WHERE binding_scope = 'selected'`);
    await client.query(`CREATE TEMP TABLE wallet_operations (
      id TEXT PRIMARY KEY,
      custody_wallet_id TEXT REFERENCES custody_wallets(id) ON DELETE SET NULL
    )`);

    // org_dup holds three org-level privy configs; the newest active row wins.
    await client.query(
      `INSERT INTO custody_configs (id, organization_id, project_id, provider, status, updated_at)
       VALUES
         ('cfg_old', 'org_dup', NULL, 'privy', 'inactive', '2026-01-01T00:00:00.000Z'),
         ('cfg_mid', 'org_dup', NULL, 'privy', 'active', '2026-02-01T00:00:00.000Z'),
         ('cfg_new', 'org_dup', NULL, 'privy', 'active', '2026-03-01T00:00:00.000Z'),
         ('cfg_project', 'org_dup', 'prj_1', 'privy', 'active', '2026-01-15T00:00:00.000Z'),
         ('cfg_clean', 'org_clean', NULL, 'privy', 'active', '2026-01-01T00:00:00.000Z')`
    );
    await client.query(
      `INSERT INTO custody_wallets (id, custody_config_id, wallet_id) VALUES
         ('cwlt_new_shared', 'cfg_new', 'wallet_shared'),
         ('cwlt_mid_shared', 'cfg_mid', 'wallet_shared'),
         ('cwlt_mid_extra', 'cfg_mid', 'wallet_extra'),
         ('cwlt_old_only', 'cfg_old', 'wallet_old'),
         ('cwlt_new_shared2', 'cfg_new', 'wallet_shared2'),
         ('cwlt_old_shared2', 'cfg_old', 'wallet_shared2'),
         ('cwlt_old_shared', 'cfg_old', 'wallet_shared')`
    );
    await client.query(
      `INSERT INTO custody_scope_defaults (id, organization_id, project_id, default_custody_config_id)
       VALUES ('csd_dup', 'org_dup', NULL, 'cfg_mid')`
    );
    await client.query(
      `INSERT INTO signing_requests (id, custody_config_id) VALUES ('sr_old', 'cfg_old')`
    );
    // Dangling default pointer that must be repaired before the FK lands.
    await client.query(`UPDATE custody_configs SET default_wallet_id = 'wallet_gone'
       WHERE id = 'cfg_clean'`);

    // Dependents of the unmovable duplicate wallet (cwlt_mid_shared): all of
    // these must survive on the survivor's copy instead of cascading away.
    await client.query(
      `INSERT INTO wallet_control_profiles (id, custody_wallet_id, status) VALUES
         ('wcp_dup_active', 'cwlt_mid_shared', 'active'),
         ('wcp_dup_draft', 'cwlt_mid_shared', 'draft'),
         ('wcp_kept_active', 'cwlt_new_shared2', 'active'),
         ('wcp_dup_conflict_active', 'cwlt_old_shared2', 'active')`
    );
    await client.query(
      `INSERT INTO api_key_wallet_policy_bindings
         (id, api_key_id, wallet_id, custody_wallet_id, wallet_control_profile_id, api_key_control_profile_id, created_at) VALUES
         ('akb_dup', 'key_dup', 'wallet_shared', 'cwlt_mid_shared', NULL, NULL, '2026-01-01T00:00:00.000Z'),
         ('akb_kept', 'key_merge', 'wallet_shared2', 'cwlt_new_shared2', NULL, NULL, '2026-01-01T00:00:00.000Z'),
         ('akb_redundant', 'key_merge', 'wallet_shared2', 'cwlt_old_shared2', 'wcp_dup_conflict_active', 'akcp_loser', '2026-01-02T00:00:00.000Z'),
         ('akb_race_a', 'key_race', 'wallet_shared', 'cwlt_mid_shared', NULL, NULL, '2026-01-01T00:00:00.000Z'),
         ('akb_race_b', 'key_race', 'wallet_shared', 'cwlt_old_shared', NULL, NULL, '2026-01-02T00:00:00.000Z'),
         ('akb_locked', 'key_lock', 'wallet_shared2', 'cwlt_old_shared2', 'wcp_dup_conflict_active', NULL, '2026-01-03T00:00:00.000Z'),
         ('akb_conflict_kept', 'key_conflict', 'wallet_shared2', 'cwlt_new_shared2', 'wcp_kept_active', 'akcp_winner', '2026-01-01T00:00:00.000Z'),
         ('akb_conflict_loser', 'key_conflict', 'wallet_shared2', 'cwlt_old_shared2', 'wcp_dup_conflict_active', 'akcp_conflict_loser', '2026-01-02T00:00:00.000Z')`
    );
    await client.query(
      `INSERT INTO wallet_operations (id, custody_wallet_id)
       VALUES ('wop_dup', 'cwlt_mid_shared')`
    );

    await client.query(sql);

    const survivors = await client.query(
      `SELECT id FROM custody_configs
       WHERE organization_id = 'org_dup' AND project_id IS NULL AND provider = 'privy'`
    );
    expect(survivors.rows).toEqual([{ id: "cfg_new" }]);

    const scopeDefault = await client.query(
      `SELECT default_custody_config_id FROM custody_scope_defaults WHERE id = 'csd_dup'`
    );
    expect(scopeDefault.rows[0]?.default_custody_config_id).toBe("cfg_new");

    const signingRequest = await client.query(
      `SELECT custody_config_id FROM signing_requests WHERE id = 'sr_old'`
    );
    expect(signingRequest.rows[0]?.custody_config_id).toBe("cfg_new");

    const survivorWallets = await client.query(
      `SELECT id, wallet_id FROM custody_wallets
       WHERE custody_config_id = 'cfg_new'
       ORDER BY wallet_id`
    );
    expect(survivorWallets.rows).toEqual([
      // Moved from the duplicates…
      { id: "cwlt_mid_extra", wallet_id: "wallet_extra" },
      { id: "cwlt_old_only", wallet_id: "wallet_old" },
      // …while the survivor keeps its own copies of the shared wallet ids.
      { id: "cwlt_new_shared", wallet_id: "wallet_shared" },
      { id: "cwlt_new_shared2", wallet_id: "wallet_shared2" },
    ]);

    // The duplicate's unmovable shared wallet cascades away with its config…
    const orphanWallet = await client.query(
      `SELECT id FROM custody_wallets WHERE id = 'cwlt_mid_shared'`
    );
    expect(orphanWallet.rows).toHaveLength(0);

    // …but its dependents were repointed at the survivor's copy first.
    const profiles = await client.query(
      `SELECT id, status FROM wallet_control_profiles
       WHERE custody_wallet_id = 'cwlt_new_shared'
       ORDER BY id`
    );
    expect(profiles.rows).toEqual([
      { id: "wcp_dup_active", status: "active" },
      { id: "wcp_dup_draft", status: "draft" },
    ]);

    // When the survivor's wallet already has an active profile, the
    // duplicate's active profile is preserved on the survivor as disabled —
    // never silently cascade-deleted.
    const conflictProfiles = await client.query(
      `SELECT id, status FROM wallet_control_profiles
       WHERE custody_wallet_id = 'cwlt_new_shared2'
       ORDER BY id`
    );
    expect(conflictProfiles.rows).toEqual([
      { id: "wcp_dup_conflict_active", status: "disabled" },
      { id: "wcp_kept_active", status: "active" },
    ]);

    const binding = await client.query(
      `SELECT custody_wallet_id FROM api_key_wallet_policy_bindings WHERE id = 'akb_dup'`
    );
    expect(binding.rows[0]?.custody_wallet_id).toBe("cwlt_new_shared");

    // A key bound to both the duplicate and the surviving row keeps exactly
    // one binding — the survivor-pointing one — and inherits the deleted
    // binding's policy assignments. The inherited wallet-profile reference
    // is mapped through the demotion to the surviving wallet's active
    // profile, so the merged binding stays operable (this key already held
    // the survivor route, so this is not a downgrade).
    const mergedBindings = await client.query(
      `SELECT id, custody_wallet_id, wallet_control_profile_id, api_key_control_profile_id
       FROM api_key_wallet_policy_bindings
       WHERE api_key_id = 'key_merge'`
    );
    expect(mergedBindings.rows).toEqual([
      {
        id: "akb_kept",
        custody_wallet_id: "cwlt_new_shared2",
        wallet_control_profile_id: "wcp_kept_active",
        api_key_control_profile_id: "akcp_loser",
      },
    ]);

    // When both bindings carry explicit assignments, the surviving binding's
    // own assignments win deterministically…
    const conflictBindings = await client.query(
      `SELECT id, custody_wallet_id, wallet_control_profile_id, api_key_control_profile_id
       FROM api_key_wallet_policy_bindings
       WHERE api_key_id = 'key_conflict'`
    );
    expect(conflictBindings.rows).toEqual([
      {
        id: "akb_conflict_kept",
        custody_wallet_id: "cwlt_new_shared2",
        wallet_control_profile_id: "wcp_kept_active",
        api_key_control_profile_id: "akcp_winner",
      },
    ]);
    // …and the discarded conflicting assignment is reported, never silent.
    // Exactly one: akb_conflict_loser's api-key control profile differs from
    // the survivor's. akb_redundant does not count — one assignment was
    // inherited, and its wallet-profile reference resolves to the survivor's
    // active profile after the demotion repair.
    expect(notices.filter((n) => n.includes("conflicting policy assignment"))).toEqual([
      expect.stringContaining("Discarded 1 conflicting policy assignment(s)"),
    ]);

    // A key bound to two duplicate rows of the same surviving wallet keeps
    // exactly one binding, repointed at the survivor.
    const racedBindings = await client.query(
      `SELECT id, custody_wallet_id FROM api_key_wallet_policy_bindings
       WHERE api_key_id = 'key_race'`
    );
    expect(racedBindings.rows).toEqual([
      { id: "akb_race_a", custody_wallet_id: "cwlt_new_shared" },
    ]);

    // A binding whose only route ran through the duplicate wallet row keeps
    // its reference to the demoted (now-disabled) profile: policy resolution
    // fails closed, so the key is blocked until an operator re-assigns it —
    // never silently re-governed by the survivor's possibly weaker active
    // profile.
    const lockedBinding = await client.query(
      `SELECT custody_wallet_id, wallet_control_profile_id
       FROM api_key_wallet_policy_bindings
       WHERE id = 'akb_locked'`
    );
    expect(lockedBinding.rows).toEqual([
      {
        custody_wallet_id: "cwlt_new_shared2",
        wallet_control_profile_id: "wcp_dup_conflict_active",
      },
    ]);
    // …and the lockout is reported for operator action.
    expect(notices.filter((n) => n.includes("fail closed"))).toEqual([
      expect.stringContaining(
        "1 API-key wallet binding(s) referencing a now-disabled control profile"
      ),
    ]);

    const operation = await client.query(
      `SELECT custody_wallet_id FROM wallet_operations WHERE id = 'wop_dup'`
    );
    expect(operation.rows[0]?.custody_wallet_id).toBe("cwlt_new_shared");

    // Untouched scopes survive, and the dangling default was repaired.
    const clean = await client.query(
      `SELECT default_wallet_id FROM custody_configs WHERE id = 'cfg_clean'`
    );
    expect(clean.rows[0]?.default_wallet_id).toBeNull();
    const project = await client.query(`SELECT id FROM custody_configs WHERE id = 'cfg_project'`);
    expect(project.rows).toHaveLength(1);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
