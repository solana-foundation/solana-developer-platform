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
         ('cwlt_old_only', 'cfg_old', 'wallet_old')`
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
      // …while the survivor keeps its own copy of the shared wallet id.
      { id: "cwlt_new_shared", wallet_id: "wallet_shared" },
    ]);

    // The duplicate's unmovable shared wallet cascades away with its config.
    const orphanWallet = await client.query(
      `SELECT id FROM custody_wallets WHERE id = 'cwlt_mid_shared'`
    );
    expect(orphanWallet.rows).toHaveLength(0);

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
