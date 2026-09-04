import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import {
  CHECK_VIOLATION,
  expectSqlstate as expectSqlstateOn,
  FK_VIOLATION,
  seedOrgProject,
  UNIQUE_VIOLATION,
} from "@/test/helpers/migration-db";

// The test database is already fully migrated by src/test/node-global-setup.ts,
// so 0057's tables exist before this file runs. That makes the assertions here
// behavioural rather than structural-only: every test opens a transaction,
// inserts real rows against the real schema, and rolls back.

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0057_helius_rings.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

const TABLES = [
  "helius_rings_wallets",
  "helius_rings_key_refs",
  "helius_rings_zones",
  "helius_rings_operations",
  "helius_rings_timelocks",
  "helius_rings_events",
  "helius_rings_asset_allowlist",
  "helius_rings_runtime_health",
];

let client: Client;

const expectSqlstate = (work: () => Promise<unknown>, sqlstate: string) =>
  expectSqlstateOn(client, work, sqlstate);

/** Seeds an org, project and Rings wallet, returning their ids. */
async function seedWallet(tag: string): Promise<{
  organizationId: string;
  projectId: string;
  walletId: string;
}> {
  const { organizationId, projectId } = await seedOrgProject(client, tag);
  const walletId = `hrw_${tag}`;
  await client.query(
    `INSERT INTO helius_rings_wallets (id, organization_id, project_id, sdp_wallet_id, name)
     VALUES ($1, $2, $3, $4, 'Treasury')`,
    [walletId, organizationId, projectId, `sdpw_${tag}`]
  );

  return { organizationId, projectId, walletId };
}

async function insertOperation(
  overrides: Record<string, string | boolean | null> & {
    id: string;
    organization_id: string;
    project_id: string;
    wallet_id: string;
    intent_key: string;
  }
): Promise<void> {
  const row: Record<string, string | boolean | null> = { op_type: "shield", ...overrides };
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  await client.query(
    `INSERT INTO helius_rings_operations (${columns.join(", ")}) VALUES (${placeholders})`,
    columns.map((column) => row[column])
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0057_helius_rings schema", () => {
  it("creates every table and the indexes the module reads through", async () => {
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)
       ORDER BY table_name`,
      [TABLES]
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([...TABLES].sort());

    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename LIKE 'helius_rings%'`
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "idx_helius_rings_wallets_project_sdp",
        "idx_helius_rings_key_refs_wallet_kind",
        "helius_rings_zones_wallet_name_key",
        "idx_helius_rings_operations_intent_key",
        "idx_helius_rings_operations_wallet_created",
        "idx_helius_rings_operations_in_flight",
        "idx_helius_rings_timelocks_pending",
        "idx_helius_rings_events_operation_created",
      ])
    );
  });

  it("re-running the migration is a no-op", async () => {
    const before = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM helius_rings_asset_allowlist"
    );

    // Every statement is IF NOT EXISTS and the seed is ON CONFLICT DO NOTHING,
    // so a second application must neither throw nor duplicate the seed.
    await expect(client.query(migrationSql)).resolves.toBeDefined();

    const after = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM helius_rings_asset_allowlist"
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("seeds the allowlist with SOL and devnet USDC only", async () => {
    const seeded = await client.query<{ mint: string; symbol: string; decimals: number }>(
      "SELECT mint, symbol, decimals FROM helius_rings_asset_allowlist ORDER BY symbol"
    );
    expect(seeded.rows).toEqual([
      { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
      { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", decimals: 6 },
    ]);
  });
});

describe("0057_helius_rings idempotency contract", () => {
  it("rejects a second operation reusing an intent_key", async () => {
    const { organizationId, projectId, walletId } = await seedWallet("intent");
    const base = {
      organization_id: organizationId,
      project_id: projectId,
      wallet_id: walletId,
      intent_key: "intent_abc",
    };

    await insertOperation({ id: "hro_first", ...base });
    await expectSqlstate(() => insertOperation({ id: "hro_second", ...base }), UNIQUE_VIOLATION);

    // The reserved row is untouched — this is what lets reserveIntent() return
    // the pre-existing operation instead of creating a ghost duplicate.
    const rows = await client.query<{ id: string }>(
      "SELECT id FROM helius_rings_operations WHERE intent_key = $1",
      ["intent_abc"]
    );
    expect(rows.rows.map((row) => row.id)).toEqual(["hro_first"]);
  });

  it("keeps the retry chain when a retried operation is deleted", async () => {
    const { organizationId, projectId, walletId } = await seedWallet("lineage");
    const base = { organization_id: organizationId, project_id: projectId, wallet_id: walletId };

    await insertOperation({ id: "hro_original", intent_key: "intent_original", ...base });
    await insertOperation({
      id: "hro_retry",
      intent_key: "intent_retry",
      retry_of_operation_id: "hro_original",
      ...base,
    });

    await client.query("DELETE FROM helius_rings_operations WHERE id = 'hro_original'");

    // SET NULL, not CASCADE: the retry survives its parent's deletion so the
    // audit trail does not evaporate.
    const retry = await client.query<{ id: string; retry_of_operation_id: string | null }>(
      "SELECT id, retry_of_operation_id FROM helius_rings_operations WHERE id = 'hro_retry'"
    );
    expect(retry.rows).toEqual([{ id: "hro_retry", retry_of_operation_id: null }]);
  });

  it("refuses an operation that is its own retry", async () => {
    const { organizationId, projectId, walletId } = await seedWallet("selfretry");
    await expectSqlstate(
      () =>
        insertOperation({
          id: "hro_self",
          organization_id: organizationId,
          project_id: projectId,
          wallet_id: walletId,
          intent_key: "intent_self",
          retry_of_operation_id: "hro_self",
        }),
      CHECK_VIOLATION
    );
  });
});

describe("0057_helius_rings tenant isolation", () => {
  it("refuses an operation pointing at a wallet in another project", async () => {
    const owner = await seedWallet("owner");
    const other = await seedWallet("other");

    // The composite (wallet_id, organization_id, project_id) FK is what makes
    // this a foreign-key error rather than a silently accepted cross-tenant row.
    await expectSqlstate(
      () =>
        insertOperation({
          id: "hro_crosstenant",
          organization_id: other.organizationId,
          project_id: other.projectId,
          wallet_id: owner.walletId,
          intent_key: "intent_crosstenant",
        }),
      FK_VIOLATION
    );
  });

  it("refuses an operation pointing at another wallet's zone", async () => {
    const owner = await seedWallet("zoneowner");
    const other = await seedWallet("zoneother");
    await client.query(
      "INSERT INTO helius_rings_zones (id, wallet_id, name) VALUES ('hrz_owner', $1, 'Payroll')",
      [owner.walletId]
    );

    // The composite (zone_id, wallet_id) FK rejects the cross-wallet reference.
    await expectSqlstate(
      () =>
        insertOperation({
          id: "hro_crosszone",
          organization_id: other.organizationId,
          project_id: other.projectId,
          wallet_id: other.walletId,
          zone_id: "hrz_owner",
          intent_key: "intent_crosszone",
        }),
      FK_VIOLATION
    );

    await expect(
      insertOperation({
        id: "hro_ownzone",
        organization_id: owner.organizationId,
        project_id: owner.projectId,
        wallet_id: owner.walletId,
        zone_id: "hrz_owner",
        intent_key: "intent_ownzone",
      })
    ).resolves.toBeUndefined();
  });

  it("clears only zone_id when a referenced zone is deleted", async () => {
    const { organizationId, projectId, walletId } = await seedWallet("zonedel");
    await client.query(
      "INSERT INTO helius_rings_zones (id, wallet_id, name) VALUES ('hrz_del', $1, 'Payroll')",
      [walletId]
    );
    await insertOperation({
      id: "hro_zonedel",
      organization_id: organizationId,
      project_id: projectId,
      wallet_id: walletId,
      zone_id: "hrz_del",
      intent_key: "intent_zonedel",
    });

    await client.query("DELETE FROM helius_rings_zones WHERE id = 'hrz_del'");

    // The SET NULL column list must not null wallet_id along with zone_id.
    const { rows } = await client.query(
      "SELECT wallet_id, zone_id FROM helius_rings_operations WHERE id = 'hro_zonedel'"
    );
    expect(rows[0]).toEqual({ wallet_id: walletId, zone_id: null });
  });

  it("cascades wallets, key refs, operations and events when the project goes", async () => {
    const { organizationId, projectId, walletId } = await seedWallet("cascade");
    await insertOperation({
      id: "hro_cascade",
      organization_id: organizationId,
      project_id: projectId,
      wallet_id: walletId,
      intent_key: "intent_cascade",
    });
    await client.query(
      `INSERT INTO helius_rings_key_refs (id, wallet_id, kind, ciphertext, key_version, material_tag)
       VALUES ('hrk_cascade', $1, 'viewing', 'ct', 'v1', 'simulated')`,
      [walletId]
    );
    await client.query(
      `INSERT INTO helius_rings_events (id, operation_id, kind, payload)
       VALUES ('hre_cascade', 'hro_cascade', 'created', '{"note":"ok"}'::jsonb)`
    );

    await client.query("DELETE FROM projects WHERE id = $1", [projectId]);

    for (const table of ["helius_rings_wallets", "helius_rings_operations"]) {
      const rows = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE project_id = $1`,
        [projectId]
      );
      expect(rows.rows[0]?.count).toBe("0");
    }
    for (const table of ["helius_rings_key_refs", "helius_rings_events"]) {
      const rows = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`
      );
      expect(rows.rows[0]?.count).toBe("0");
    }
  });

  it("holds one Rings wallet per SDP custody wallet per project", async () => {
    const { organizationId, projectId } = await seedWallet("onewallet");
    await expectSqlstate(
      () =>
        client.query(
          `INSERT INTO helius_rings_wallets (id, organization_id, project_id, sdp_wallet_id, name)
         VALUES ('hrw_dupe', $1, $2, 'sdpw_onewallet', 'Second')`,
          [organizationId, projectId]
        ),
      UNIQUE_VIOLATION
    );
  });

  it("holds one viewing key and one nullifier key per wallet", async () => {
    const { walletId } = await seedWallet("keyrefs");
    const insert = (id: string, kind: string) =>
      client.query(
        `INSERT INTO helius_rings_key_refs (id, wallet_id, kind, ciphertext, key_version, material_tag)
         VALUES ($1, $2, $3, 'ct', 'v1', 'simulated')`,
        [id, walletId, kind]
      );

    await insert("hrk_viewing", "viewing");
    await insert("hrk_nullifier", "nullifier");
    await expectSqlstate(() => insert("hrk_viewing_dupe", "viewing"), UNIQUE_VIOLATION);
  });
});

describe("0057_helius_rings value-set and coherence constraints", () => {
  it("pins network to devnet", async () => {
    const { organizationId, projectId } = await seedWallet("network");
    await expectSqlstate(
      () =>
        client.query(
          `INSERT INTO helius_rings_wallets (id, organization_id, project_id, sdp_wallet_id, name, network)
         VALUES ('hrw_mainnet', $1, $2, 'sdpw_mainnet', 'Mainnet', 'mainnet-beta')`,
          [organizationId, projectId]
        ),
      CHECK_VIOLATION
    );
  });

  it("rejects states and op types outside the domain constants", async () => {
    const { organizationId, projectId, walletId } = await seedWallet("valuesets");
    const base = {
      organization_id: organizationId,
      project_id: projectId,
      wallet_id: walletId,
    };

    await expectSqlstate(
      () =>
        insertOperation({ id: "hro_badstate", intent_key: "i1", state: "teleporting", ...base }),
      CHECK_VIOLATION
    );
    await expectSqlstate(
      () => insertOperation({ id: "hro_badtype", intent_key: "i2", op_type: "rugpull", ...base }),
      CHECK_VIOLATION
    );
    await expectSqlstate(
      () =>
        insertOperation({
          id: "hro_badproof",
          intent_key: "i3",
          proof_source: "vibes",
          ...base,
        }),
      CHECK_VIOLATION
    );
  });

  it("keeps transfer_mode consistent with op_type", async () => {
    const { organizationId, projectId, walletId } = await seedWallet("mode");
    const base = {
      organization_id: organizationId,
      project_id: projectId,
      wallet_id: walletId,
    };

    // An anonymous transfer recorded as registered would tell the operator
    // their counterparty was disclosed when it was not.
    await expectSqlstate(
      () =>
        insertOperation({
          id: "hro_mismatch",
          intent_key: "m1",
          op_type: "transfer_anonymous",
          transfer_mode: "registered",
          ...base,
        }),
      CHECK_VIOLATION
    );
    // A shield carries no transfer mode at all.
    await expectSqlstate(
      () =>
        insertOperation({
          id: "hro_straymode",
          intent_key: "m2",
          op_type: "shield",
          transfer_mode: "registered",
          ...base,
        }),
      CHECK_VIOLATION
    );

    await insertOperation({
      id: "hro_anon",
      intent_key: "m3",
      op_type: "transfer_anonymous",
      transfer_mode: "anonymous",
      ...base,
    });
    const stored = await client.query<{ transfer_mode: string }>(
      "SELECT transfer_mode FROM helius_rings_operations WHERE id = 'hro_anon'"
    );
    expect(stored.rows).toEqual([{ transfer_mode: "anonymous" }]);
  });

  it("ties failure detail to the failed state", async () => {
    const { organizationId, projectId, walletId } = await seedWallet("failure");
    const base = {
      organization_id: organizationId,
      project_id: projectId,
      wallet_id: walletId,
    };

    // failed without a code is unactionable in the recovery UI.
    await expectSqlstate(
      () => insertOperation({ id: "hro_bare", intent_key: "f1", state: "failed", ...base }),
      CHECK_VIOLATION
    );
    // A live operation carrying failure text misreports itself as broken.
    await expectSqlstate(
      () =>
        insertOperation({
          id: "hro_stale",
          intent_key: "f2",
          state: "proving",
          failure_code: "proof_failed",
          failure_message: "boom",
          retryable: true,
          ...base,
        }),
      CHECK_VIOLATION
    );
    await expectSqlstate(
      () =>
        insertOperation({
          id: "hro_unknowncode",
          intent_key: "f3",
          state: "failed",
          failure_code: "cosmic_rays",
          failure_message: "boom",
          retryable: false,
          ...base,
        }),
      CHECK_VIOLATION
    );

    await insertOperation({
      id: "hro_failed",
      intent_key: "f4",
      state: "failed",
      failure_code: "indexing_timeout",
      failure_message: "photon did not index in time",
      retryable: true,
      ...base,
    });
    const stored = await client.query<{ failure_code: string; retryable: boolean }>(
      "SELECT failure_code, retryable FROM helius_rings_operations WHERE id = 'hro_failed'"
    );
    expect(stored.rows).toEqual([{ failure_code: "indexing_timeout", retryable: true }]);
  });

  it("refuses a timelock released before it unlocks", async () => {
    const { organizationId, projectId, walletId } = await seedWallet("timelock");
    await insertOperation({
      id: "hro_timelock",
      organization_id: organizationId,
      project_id: projectId,
      wallet_id: walletId,
      intent_key: "t1",
      op_type: "timelock_create",
    });

    const insertTimelock = (releasedAt: string | null) =>
      client.query(
        `INSERT INTO helius_rings_timelocks (operation_id, unlock_at, released_at, beneficiary_addr)
         VALUES ('hro_timelock', '2026-09-01T00:00:00.000Z', $1, 'beneficiary')`,
        [releasedAt]
      );

    await expectSqlstate(() => insertTimelock("2026-08-01T00:00:00.000Z"), CHECK_VIOLATION);
    await expect(insertTimelock("2026-09-02T00:00:00.000Z")).resolves.toBeDefined();
  });

  it("rejects timelock timestamps that are not fixed-width UTC", async () => {
    const { organizationId, projectId, walletId } = await seedWallet("tlformat");
    await insertOperation({
      id: "hro_tlformat",
      organization_id: organizationId,
      project_id: projectId,
      wallet_id: walletId,
      intent_key: "tf1",
      op_type: "timelock_create",
    });

    const insertTimelock = (unlockAt: string, releasedAt: string | null) =>
      client.query(
        `INSERT INTO helius_rings_timelocks (operation_id, unlock_at, released_at, beneficiary_addr)
         VALUES ('hro_tlformat', $1, $2, 'beneficiary')`,
        [unlockAt, releasedAt]
      );

    // An offset value sorts lexically before a Z value it chronologically follows.
    await expectSqlstate(
      () => insertTimelock("2026-08-31T23:30:00.000-01:00", null),
      CHECK_VIOLATION
    );
    await expectSqlstate(
      () => insertTimelock("2026-09-01T00:00:00.000Z", "2026-09-01T23:30:00.000-01:00"),
      CHECK_VIOLATION
    );
    await expectSqlstate(() => insertTimelock("2026-09-01T00:00:00Z", null), CHECK_VIOLATION);

    await expectSqlstate(
      () =>
        insertOperation({
          id: "hro_tlformat2",
          organization_id: organizationId,
          project_id: projectId,
          wallet_id: walletId,
          intent_key: "tf2",
          op_type: "timelock_create",
          timelock_unlock_at: "2026-08-31T23:30:00.000-01:00",
        }),
      CHECK_VIOLATION
    );
  });

  it("requires event payloads to be JSON objects", async () => {
    const { organizationId, projectId, walletId } = await seedWallet("events");
    await insertOperation({
      id: "hro_events",
      organization_id: organizationId,
      project_id: projectId,
      wallet_id: walletId,
      intent_key: "e1",
    });

    await expectSqlstate(
      () =>
        client.query(
          `INSERT INTO helius_rings_events (id, operation_id, kind, payload)
         VALUES ('hre_scalar', 'hro_events', 'noted', '"just a string"'::jsonb)`
        ),
      CHECK_VIOLATION
    );
    await expect(
      client.query(
        `INSERT INTO helius_rings_events (id, operation_id, kind, payload)
         VALUES ('hre_null', 'hro_events', 'noted', NULL)`
      )
    ).resolves.toBeDefined();
  });

  it("stores one runtime health row per project and component", async () => {
    const { projectId } = await seedWallet("health");
    const upsert = (component: string, status: string) =>
      client.query(
        `INSERT INTO helius_rings_runtime_health (project_id, component, status)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, component) DO UPDATE SET status = EXCLUDED.status`,
        [projectId, component, status]
      );

    await upsert("photon", "green");
    await upsert("photon", "red");
    await expectSqlstate(() => upsert("telepathy", "green"), CHECK_VIOLATION);
    await expectSqlstate(() => upsert("photon", "chartreuse"), CHECK_VIOLATION);

    const rows = await client.query<{ component: string; status: string }>(
      "SELECT component, status FROM helius_rings_runtime_health WHERE project_id = $1",
      [projectId]
    );
    expect(rows.rows).toEqual([{ component: "photon", status: "red" }]);
  });
});
