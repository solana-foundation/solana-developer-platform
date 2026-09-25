import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

/**
 * SOLA9-439 data triage: the cached public projection must be healed where the
 * vulnerable code cached a chain.decimals that disagrees with the token row,
 * and left exactly where nothing wrong was being served.
 */
it("rebinds divergent cached chain.decimals to the token scale, touching nothing else", async () => {
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0119_asset_profile_public_chain_decimals_binding.sql"
  );
  const sql = readFileSync(migrationPath, "utf8");
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE issued_tokens (
      id TEXT PRIMARY KEY,
      decimals INTEGER NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE asset_profiles (
      id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      public_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL DEFAULT sdp_iso_now()
    )`);

    await client.query(`INSERT INTO issued_tokens (id, decimals) VALUES
      ('tok_drifted', 6),
      ('tok_matching', 6),
      ('tok_no_chain', 9),
      ('tok_chain_without_decimals', 9),
      ('tok_archived_drift', 2)`);
    await client.query(`INSERT INTO asset_profiles (id, token_id, public_metadata, status) VALUES
      ('profile_drifted', 'tok_drifted',
       '{"asset":{"name":"USD"},"chain":{"decimals":18}}', 'active'),
      ('profile_matching', 'tok_matching',
       '{"asset":{"name":"USD"},"chain":{"decimals":6}}', 'active'),
      ('profile_no_chain', 'tok_no_chain',
       '{"asset":{"name":"USD"}}', 'active'),
      ('profile_chain_without_decimals', 'tok_chain_without_decimals',
       '{"chain":{"rpc":"https://example"}}', 'active'),
      ('profile_archived_drift', 'tok_archived_drift',
       '{"chain":{"decimals":8}}', 'archived')`);

    await client.query(sql);

    const { rows } = await client.query<{ id: string; public_metadata: Record<string, unknown> }>(
      "SELECT id, public_metadata FROM asset_profiles ORDER BY id"
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: "profile_archived_drift",
        // Archived profiles serve nothing, but healing them keeps any future
        // reactivation from republishing the stale scale.
        public_metadata: { chain: { decimals: 2 } },
      }),
      expect.objectContaining({
        id: "profile_chain_without_decimals",
        // Absence is not a wrong served scale; the old semantics omitted it.
        public_metadata: { chain: { rpc: "https://example" } },
      }),
      expect.objectContaining({
        id: "profile_drifted",
        public_metadata: { asset: { name: "USD" }, chain: { decimals: 6 } },
      }),
      expect.objectContaining({
        id: "profile_matching",
        public_metadata: { asset: { name: "USD" }, chain: { decimals: 6 } },
      }),
      expect.objectContaining({
        id: "profile_no_chain",
        public_metadata: { asset: { name: "USD" } },
      }),
    ]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
