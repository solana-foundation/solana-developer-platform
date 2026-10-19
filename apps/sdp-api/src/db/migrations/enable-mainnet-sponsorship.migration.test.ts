import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type {
  SponsorshipBudgetScopeType,
  SponsorshipNetwork,
} from "@/db/repositories/sponsorship-budget.repository";
import { adminDatabaseUrl } from "@/test/helpers/env";

type PolicyRow = {
  id: string;
  network: SponsorshipNetwork;
  scope_type: SponsorshipBudgetScopeType;
  scope_id: string | null;
  enabled: boolean;
  per_transaction_lamports: string;
  hourly_lamports: string;
  daily_lamports: string;
  version: string;
  updated_by: string;
  update_reason: string;
  created_at: string;
  updated_at: string;
};

type RevisionRow = {
  id: string;
  policy_id: string;
  network: SponsorshipNetwork;
  scope_type: SponsorshipBudgetScopeType;
  scope_id: string | null;
  enabled: boolean;
  per_transaction_lamports: string;
  hourly_lamports: string;
  daily_lamports: string;
  version: string;
  changed_by: string;
  change_reason: string;
  created_at: string;
};

const migrationSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0140_enable_mainnet_sponsorship.sql"
  ),
  "utf8"
);
const seededAt = "2026-01-01T00:00:00.000Z";
let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
  await client.query(`CREATE TEMP TABLE sponsorship_budget_policies (
    id TEXT PRIMARY KEY,
    network TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet')),
    scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'organization', 'project')),
    scope_id TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    per_transaction_lamports BIGINT NOT NULL,
    hourly_lamports BIGINT NOT NULL,
    daily_lamports BIGINT NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    updated_by TEXT NOT NULL,
    update_reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now()
  )`);
  await client.query(`CREATE TEMP TABLE sponsorship_budget_policy_revisions (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES sponsorship_budget_policies(id) ON DELETE RESTRICT,
    network TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT,
    enabled BOOLEAN NOT NULL,
    per_transaction_lamports BIGINT NOT NULL,
    hourly_lamports BIGINT NOT NULL,
    daily_lamports BIGINT NOT NULL,
    version BIGINT NOT NULL,
    changed_by TEXT NOT NULL,
    change_reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    UNIQUE (policy_id, version)
  )`);
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

async function selectPolicies(): Promise<PolicyRow[]> {
  const { rows } = await client.query<PolicyRow>(
    `SELECT id, network, scope_type, scope_id, enabled,
            per_transaction_lamports::text AS per_transaction_lamports,
            hourly_lamports::text AS hourly_lamports,
            daily_lamports::text AS daily_lamports,
            version::text AS version,
            updated_by, update_reason, created_at, updated_at
       FROM sponsorship_budget_policies
      ORDER BY id`
  );
  return rows;
}

async function selectRevisions(): Promise<RevisionRow[]> {
  const { rows } = await client.query<RevisionRow>(
    `SELECT id, policy_id, network, scope_type, scope_id, enabled,
            per_transaction_lamports::text AS per_transaction_lamports,
            hourly_lamports::text AS hourly_lamports,
            daily_lamports::text AS daily_lamports,
            version::text AS version,
            changed_by, change_reason, created_at
       FROM sponsorship_budget_policy_revisions
      ORDER BY id`
  );
  return rows;
}

it("enables the mainnet global policy left in its 0055 seed state and records the revision", async () => {
  await client.query(
    `INSERT INTO sponsorship_budget_policies (
       id, network, scope_type, scope_id, enabled,
       per_transaction_lamports, hourly_lamports, daily_lamports,
       version, updated_by, update_reason, created_at, updated_at
     ) VALUES
       ('sbp_devnet_global', 'devnet', 'global', NULL, TRUE, 10000000, 2000000000, 10000000000, 1, 'migration', 'Initial devnet sponsorship controls', $1, $1),
       ('sbp_mainnet_global', 'mainnet', 'global', NULL, FALSE, 10000000, 500000000, 1000000000, 1, 'migration', 'Mainnet remains disabled pending operator approval', $1, $1)`,
    [seededAt]
  );
  const {
    rows: [{ now }],
  } = await client.query<{ now: string }>("SELECT sdp_iso_now() AS now");

  await client.query(migrationSql);

  expect(await selectPolicies()).toEqual([
    {
      id: "sbp_devnet_global",
      network: "devnet",
      scope_type: "global",
      scope_id: null,
      enabled: true,
      per_transaction_lamports: "10000000",
      hourly_lamports: "2000000000",
      daily_lamports: "10000000000",
      version: "1",
      updated_by: "migration",
      update_reason: "Initial devnet sponsorship controls",
      created_at: seededAt,
      updated_at: seededAt,
    },
    {
      id: "sbp_mainnet_global",
      network: "mainnet",
      scope_type: "global",
      scope_id: null,
      enabled: true,
      per_transaction_lamports: "10000000",
      hourly_lamports: "500000000",
      daily_lamports: "1000000000",
      version: "2",
      updated_by: "migration",
      update_reason: "Mainnet sponsorship approved for launch",
      created_at: seededAt,
      updated_at: now,
    },
  ]);
  expect(await selectRevisions()).toEqual([
    {
      id: "sbpr_sbp_mainnet_global_2",
      policy_id: "sbp_mainnet_global",
      network: "mainnet",
      scope_type: "global",
      scope_id: null,
      enabled: true,
      per_transaction_lamports: "10000000",
      hourly_lamports: "500000000",
      daily_lamports: "1000000000",
      version: "2",
      changed_by: "migration",
      change_reason: "Mainnet sponsorship approved for launch",
      created_at: now,
    },
  ]);
});

it("leaves a mainnet global policy an operator disabled untouched", async () => {
  await client.query(
    `INSERT INTO sponsorship_budget_policies (
       id, network, scope_type, scope_id, enabled,
       per_transaction_lamports, hourly_lamports, daily_lamports,
       version, updated_by, update_reason, created_at, updated_at
     ) VALUES
       ('sbp_mainnet_global', 'mainnet', 'global', NULL, FALSE, 10000000, 500000000, 1000000000, 3, 'system:sponsorship-breaker', 'Sponsorship breaker tripped', $1, $1)`,
    [seededAt]
  );

  await client.query(migrationSql);

  expect(await selectPolicies()).toEqual([
    {
      id: "sbp_mainnet_global",
      network: "mainnet",
      scope_type: "global",
      scope_id: null,
      enabled: false,
      per_transaction_lamports: "10000000",
      hourly_lamports: "500000000",
      daily_lamports: "1000000000",
      version: "3",
      updated_by: "system:sponsorship-breaker",
      update_reason: "Sponsorship breaker tripped",
      created_at: seededAt,
      updated_at: seededAt,
    },
  ]);
  expect(await selectRevisions()).toEqual([]);
});
