import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";
import { applyPostgresMigration } from "../../../scripts/lib/run-postgres-migrations.mjs";

// 0005 established sandbox/production as a project-level boundary. Its
// payment_transfers backfill must resolve a legacy transfer's project from the
// key that initiated it (while api_keys.environment still exists), not blindly
// assign every NULL-project row to default-sandbox: production history
// initiated through a legacy production key must stay in the production
// ledger, and rows whose origin cannot be established must be quarantined
// (project_id NULL, invisible under every project scope) instead of surfacing
// under sandbox scope.
//
// The worker database is already fully migrated, so this test builds a
// scratch database on the same cluster, applies the real 0001-0004 schema,
// seeds synthetic legacy rows, and replays the real 0005 file.

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "postgres");

const LEGACY_MIGRATIONS = [
  "0001_initial_schema.sql",
  "0002_default_organization_tier_enterprise.sql",
  "0003_counterparties.sql",
  "0004_counterparties_project_nullable.sql",
] as const;

const BOUNDARY_MIGRATION = "0005_project_environment_boundary.sql";

const ORG = "org_0005_boundary";
const USER = "usr_0005_boundary";
const SANDBOX_PROJECT = "prj_sandbox_legacy";
const PRODUCTION_PROJECT = "prj_production_legacy";
const PRODUCTION_KEY = "key_legacy_prod";
const SANDBOX_KEY = "key_legacy_sandbox";

let scratchDatabase: string;
let admin: Client;
let client: Client;

async function applyMigrationFile(client: Client, migrationFile: string): Promise<void> {
  const sql = readFileSync(path.join(migrationsDir, migrationFile), "utf8");
  await applyPostgresMigration({ client, migrationFile, sql });
}

beforeAll(async () => {
  scratchDatabase = `sdp_0005_boundary_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
  admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${scratchDatabase}"`);

  const scratchUrl = new URL(adminDatabaseUrl);
  scratchUrl.pathname = `/${scratchDatabase}`;
  client = new Client({ connectionString: scratchUrl.toString() });
  await client.connect();

  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY)");
  for (const migrationFile of LEGACY_MIGRATIONS) {
    await applyMigrationFile(client, migrationFile);
  }

  await client.query(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Boundary Org', 'boundary-org');
    INSERT INTO users (id, email, email_verified) VALUES ('${USER}', 'boundary@example.test', 1);
    INSERT INTO organization_members (id, organization_id, user_id, role, status)
      VALUES ('om_0005_boundary', '${ORG}', '${USER}', 'admin', 'active');
    INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
      VALUES
        ('${SANDBOX_PROJECT}', '${ORG}', 'Legacy Sandbox', 'default-project', 'sandbox', 'active', '${USER}'),
        ('${PRODUCTION_PROJECT}', '${ORG}', 'Legacy Production', 'legacy-production', 'production', 'active', '${USER}');
    INSERT INTO api_keys (
      id, organization_id, project_id, created_by, name, key_prefix, key_hash,
      role, environment, status
    ) VALUES
      ('${PRODUCTION_KEY}', '${ORG}', NULL, '${USER}', 'Legacy Production Key',
       'sk_live_0005', 'hash_0005_prod', 'api_admin', 'production', 'active'),
      ('${SANDBOX_KEY}', '${ORG}', NULL, '${USER}', 'Legacy Sandbox Key',
       'sk_test_0005', 'hash_0005_sandbox', 'api_admin', 'sandbox', 'active');
    INSERT INTO payment_transfers (
      id, organization_id, project_id, wallet_id, source_address,
      destination_address, token, amount, type, direction, status,
      initiated_by_key_id, created_at, updated_at
    ) VALUES
      ('xfr_legacy_prod', '${ORG}', NULL, 'wallet_0005',
       'Source111111111111111111111111111111111111',
       'Destination111111111111111111111111111111111', 'SOL', '1',
       'transfer', 'outbound', 'confirmed', '${PRODUCTION_KEY}',
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('xfr_legacy_sandbox', '${ORG}', NULL, 'wallet_0005',
       'Source222222222222222222222222222222222222',
       'Destination222222222222222222222222222222222', 'SOL', '2',
       'transfer', 'outbound', 'confirmed', '${SANDBOX_KEY}',
       '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
      ('xfr_scoped_prod', '${ORG}', '${PRODUCTION_PROJECT}', 'wallet_0005',
       'Source333333333333333333333333333333333333',
       'Destination333333333333333333333333333333333', 'SOL', '3',
       'transfer', 'outbound', 'confirmed', NULL,
       '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'),
      ('xfr_no_provenance', '${ORG}', NULL, 'wallet_0005',
       'Source444444444444444444444444444444444444',
       'Destination444444444444444444444444444444444', 'SOL', '4',
       'transfer', 'outbound', 'confirmed', NULL,
       '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'),
      ('xfr_dangling_key', '${ORG}', NULL, 'wallet_0005',
       'Source555555555555555555555555555555555555',
       'Destination555555555555555555555555555555555', 'SOL', '5',
       'transfer', 'outbound', 'confirmed', 'key_deleted_before_0005',
       '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:04.000Z'),
      ('xfr_cross_org_key', '${ORG}', NULL, 'wallet_0005',
       'Source666666666666666666666666666666666666',
       'Destination666666666666666666666666666666666', 'SOL', '6',
       'transfer', 'outbound', 'confirmed', 'key_other_org',
       '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:05.000Z');

    INSERT INTO organizations (id, name, slug) VALUES ('org_0005_other', 'Other Org', 'other-org');
    -- A member so 0005's default-project creation (steps 2-3) applies to this
    -- org too; its key then backfills to its own default-production project.
    INSERT INTO organization_members (id, organization_id, user_id, role, status)
      VALUES ('om_0005_other', 'org_0005_other', '${USER}', 'admin', 'active');
    INSERT INTO api_keys (
      id, organization_id, project_id, created_by, name, key_prefix, key_hash,
      role, environment, status
    ) VALUES (
      'key_other_org', 'org_0005_other', NULL, '${USER}', 'Other Org Key',
      'sk_live_other', 'hash_0005_other', 'api_admin', 'production', 'active'
    );
  `);
}, 120_000);

// Teardown must never wedge the suite: race every step, and let
// DROP DATABASE ... WITH (FORCE) terminate any connection a hung end() left
// behind. The scratch database lives on the ephemeral testcontainers cluster,
// so a failed drop is harmless.
async function settle(promise: Promise<unknown> | undefined, ms: number): Promise<void> {
  await Promise.race([
    promise?.catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

afterAll(async () => {
  await settle(client?.end(), 5_000);
  if (admin && scratchDatabase) {
    await settle(admin.query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`), 30_000);
  }
  await settle(admin?.end(), 5_000);
}, 120_000);

describe("0005 project environment boundary", () => {
  it("keeps legacy production transfers in the production ledger and quarantines unknown-origin rows", async () => {
    await applyMigrationFile(client, BOUNDARY_MIGRATION);

    // api_keys backfill itself is unchanged: keys resolve from environment.
    const keyRows = await client.query<{ id: string; project_id: string }>(
      "SELECT id, project_id FROM api_keys WHERE id IN ($1, $2) ORDER BY id",
      [PRODUCTION_KEY, SANDBOX_KEY]
    );
    expect(keyRows.rows.map((row) => [row.id, row.project_id])).toEqual([
      [PRODUCTION_KEY, PRODUCTION_PROJECT],
      [SANDBOX_KEY, SANDBOX_PROJECT],
    ]);

    const ledgers = await client.query<{ id: string; project_id: string | null }>(
      "SELECT id, project_id FROM payment_transfers WHERE id LIKE 'xfr_%' ORDER BY id"
    );
    const byId = new Map(ledgers.rows.map((row) => [row.id, row.project_id]));

    // Security invariant: a transfer initiated by a legacy production key
    // resolves to the production project, never to default-sandbox.
    expect(byId.get("xfr_legacy_prod")).toBe(PRODUCTION_PROJECT);

    // Supported flow preserved: a transfer initiated by a legacy sandbox key
    // lands on the org's default-sandbox project.
    expect(byId.get("xfr_legacy_sandbox")).toBe(SANDBOX_PROJECT);

    // Control: rows already scoped to a project are untouched.
    expect(byId.get("xfr_scoped_prod")).toBe(PRODUCTION_PROJECT);

    // Quarantine: rows whose origin cannot be established stay out of every
    // project ledger (NULL), rather than being assigned to default-sandbox.
    expect(byId.get("xfr_no_provenance")).toBeNull();
    expect(byId.get("xfr_dangling_key")).toBeNull();
    expect(byId.get("xfr_cross_org_key")).toBeNull();
  });
});
