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
// The migration runner records applied migrations by filename, so databases
// that already ran the pre-fix 0005 never replay the corrected file. 0119
// re-applies the corrected semantics for them: api_keys.environment is gone,
// but 0005 backfilled api_keys.project_id from it before dropping the column,
// so the initiating key's project_id is the durable provenance. 0119 must be a
// no-op on databases that applied the corrected 0005.
//
// The worker database is already fully migrated, so these tests build scratch
// databases on the same cluster, apply the real 0001-0005 schema, seed
// synthetic legacy rows, and replay the real 0119 file.

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "postgres");

const LEGACY_MIGRATIONS = [
  "0001_initial_schema.sql",
  "0002_default_organization_tier_enterprise.sql",
  "0003_counterparties.sql",
  "0004_counterparties_project_nullable.sql",
] as const;

const BOUNDARY_MIGRATION = "0005_project_environment_boundary.sql";
const REPAIR_MIGRATION = "0119_payment_transfer_provenance_repair.sql";

const ORG = "org_0005_boundary";
const USER = "usr_0005_boundary";
const SANDBOX_PROJECT = "prj_sandbox_legacy";
const PRODUCTION_PROJECT = "prj_production_legacy";
const PRODUCTION_KEY = "key_legacy_prod";
const SANDBOX_KEY = "key_legacy_sandbox";

// Rows seeded with project_id NULL: the rows the pre-fix 0005 blanket-assigned
// to default-sandbox on databases that already applied it.
const LEGACY_NULL_PROJECT_TRANSFERS = [
  "xfr_legacy_prod",
  "xfr_legacy_sandbox",
  "xfr_no_provenance",
  "xfr_dangling_key",
  "xfr_cross_org_key",
] as const;

let admin: Client;
let freshDatabase: string;
let legacyDatabase: string;
let freshClient: Client;
let legacyClient: Client;

async function applyMigrationFile(client: Client, migrationFile: string): Promise<void> {
  const sql = readFileSync(path.join(migrationsDir, migrationFile), "utf8");
  await applyPostgresMigration({ client, migrationFile, sql });
}

async function createScratchDatabase(name: string): Promise<Client> {
  await admin.query(`CREATE DATABASE "${name}"`);

  const scratchUrl = new URL(adminDatabaseUrl);
  scratchUrl.pathname = `/${name}`;
  const client = new Client({ connectionString: scratchUrl.toString() });
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

  return client;
}

beforeAll(async () => {
  admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();

  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  freshDatabase = `sdp_0005_boundary_fresh_${suffix}_test`;
  legacyDatabase = `sdp_0005_boundary_legacy_${suffix}_test`;
  freshClient = await createScratchDatabase(freshDatabase);
  legacyClient = await createScratchDatabase(legacyDatabase);
}, 120_000);

// Teardown must never wedge the suite: race every step, and let
// DROP DATABASE ... WITH (FORCE) terminate any connection a hung end() left
// behind. The scratch databases live on the ephemeral testcontainers cluster,
// so a failed drop is harmless.
async function settle(promise: Promise<unknown> | undefined, ms: number): Promise<void> {
  await Promise.race([
    promise?.catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

async function dropScratchDatabase(name: string | undefined): Promise<void> {
  if (!name) return;
  await settle(admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`), 30_000);
}

afterAll(async () => {
  await settle(freshClient?.end(), 5_000);
  await settle(legacyClient?.end(), 5_000);
  await dropScratchDatabase(freshDatabase);
  await dropScratchDatabase(legacyDatabase);
  await settle(admin?.end(), 5_000);
}, 120_000);

async function transferPlacements(client: Client): Promise<Map<string, string | null>> {
  const ledgers = await client.query<{ id: string; project_id: string | null }>(
    "SELECT id, project_id FROM payment_transfers WHERE id LIKE 'xfr_%' ORDER BY id"
  );
  return new Map(ledgers.rows.map((row) => [row.id, row.project_id]));
}

describe("0005 project environment boundary", () => {
  it("keeps legacy production transfers in the production ledger and quarantines unknown-origin rows", async () => {
    await applyMigrationFile(freshClient, BOUNDARY_MIGRATION);

    // api_keys backfill itself is unchanged: keys resolve from environment.
    const keyRows = await freshClient.query<{ id: string; project_id: string }>(
      "SELECT id, project_id FROM api_keys WHERE id IN ($1, $2) ORDER BY id",
      [PRODUCTION_KEY, SANDBOX_KEY]
    );
    expect(keyRows.rows.map((row) => [row.id, row.project_id])).toEqual([
      [PRODUCTION_KEY, PRODUCTION_PROJECT],
      [SANDBOX_KEY, SANDBOX_PROJECT],
    ]);

    const byId = await transferPlacements(freshClient);

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

  it("0119 is a no-op on databases that applied the corrected 0005", async () => {
    await applyMigrationFile(freshClient, REPAIR_MIGRATION);

    // The repair only rewrites rows sitting at their org's default-sandbox
    // project from initiating-key provenance. On a corrected database every
    // such row already matches that provenance, and quarantined rows are
    // project_id NULL, which the repair never matches.
    expect(await transferPlacements(freshClient)).toEqual(
      new Map([
        ["xfr_cross_org_key", null],
        ["xfr_dangling_key", null],
        ["xfr_legacy_prod", PRODUCTION_PROJECT],
        ["xfr_legacy_sandbox", SANDBOX_PROJECT],
        ["xfr_no_provenance", null],
        ["xfr_scoped_prod", PRODUCTION_PROJECT],
      ])
    );
  });
});

describe("0119 payment transfer provenance repair", () => {
  it("repairs databases that already applied the pre-fix 0005", async () => {
    await applyMigrationFile(legacyClient, BOUNDARY_MIGRATION);

    // Emulate the pre-fix 0005 outcome for payment_transfers: every row that
    // was NULL-project when the pre-fix migration ran was blanket-assigned to
    // the org's default-sandbox project. 0005's non-payment_transfers effects
    // (the api_keys backfill and the environment drop) are identical in both
    // variants, so replaying the real file plus this blanket reproduces that
    // end state.
    await legacyClient.query(`
      UPDATE payment_transfers
      SET    project_id = (
          SELECT p.id FROM projects p
          WHERE  p.organization_id = payment_transfers.organization_id
            AND  p.slug = 'default-sandbox'
      )
      WHERE  id IN (${LEGACY_NULL_PROJECT_TRANSFERS.map((id) => `'${id}'`).join(", ")});
    `);

    // The damaged state an already-migrated database is in: the legacy
    // production transfer sits in the sandbox ledger (the APE-843 exploit).
    const damaged = await transferPlacements(legacyClient);
    expect(damaged.get("xfr_legacy_prod")).toBe(SANDBOX_PROJECT);

    await applyMigrationFile(legacyClient, REPAIR_MIGRATION);

    const byId = await transferPlacements(legacyClient);

    // Security invariant restored: the production transfer is moved back to
    // the production ledger, proven via its initiating key's project.
    expect(byId.get("xfr_legacy_prod")).toBe(PRODUCTION_PROJECT);

    // Supported flow preserved: the sandbox transfer stays at default-sandbox.
    expect(byId.get("xfr_legacy_sandbox")).toBe(SANDBOX_PROJECT);

    // Control: rows scoped to any other project are never touched.
    expect(byId.get("xfr_scoped_prod")).toBe(PRODUCTION_PROJECT);

    // Quarantine: rows whose origin cannot be established leave the sandbox
    // ledger (NULL), matching the corrected 0005 semantics.
    expect(byId.get("xfr_no_provenance")).toBeNull();
    expect(byId.get("xfr_dangling_key")).toBeNull();
    expect(byId.get("xfr_cross_org_key")).toBeNull();
  });
});
