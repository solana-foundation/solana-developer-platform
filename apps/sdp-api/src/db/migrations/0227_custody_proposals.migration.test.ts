import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CUSTODY_PROVIDERS } from "@sdp/types/custody";
import {
  CUSTODY_PROPOSAL_ACTIVE_PHASES,
  CUSTODY_PROPOSAL_AUTHORIZATION_STATES,
  CUSTODY_PROPOSAL_PROVIDER_PHASES,
} from "@sdp/types/custody-proposals";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const migrationSql = readFileSync(path.join(directory, "0227_custody_proposals.sql"), "utf8");
const validateSql = readFileSync(
  path.join(directory, "0228_custody_proposals_validate.sql"),
  "utf8"
);
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
  await client.query(
    "CREATE TEMP TABLE projects (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, UNIQUE(id, organization_id)) ON COMMIT DROP"
  );
  await client.query("CREATE TEMP TABLE custody_wallets (id TEXT PRIMARY KEY) ON COMMIT DROP");
  await client.query(
    "CREATE TEMP TABLE payment_transfers (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(id, organization_id, project_id)) ON COMMIT DROP"
  );
  await client.query(
    "INSERT INTO projects VALUES ('project', 'org'), ('other_project', 'other_org')"
  );
  await client.query(
    "INSERT INTO payment_transfers VALUES ('payment', 'org', 'project', 'processing')"
  );
  await client.query(
    migrationSql.replace("CREATE TABLE custody_proposals", "CREATE TEMP TABLE custody_proposals")
  );
  await client.query(validateSql);
});
afterEach(async () => {
  await client.query("ROLLBACK");
});

async function insertProposal(
  overrides: {
    organization?: string;
    project?: string;
    phase?: string;
    authorization?: string;
    refusedAt?: string;
    cancelDeclinedAt?: string;
    cancelAcknowledgedAt?: string;
  } = {}
): Promise<void> {
  await client.query(
    `INSERT INTO custody_proposals
       (id, organization_id, project_id, payment_transfer_id, provider, binding,
        provider_phase, authorization_state, refused_at, cancel_declined_at, cancel_acknowledged_at,
        next_check_at, created_at, updated_at)
     VALUES ('proposal', $1, $2, 'payment', 'fireblocks', '{}', $3, $4, $5, $6, $7, $8, $8, $8)`,
    [
      overrides.organization ?? "org",
      overrides.project ?? "project",
      overrides.phase ?? "unsent",
      overrides.authorization ?? "authorized",
      overrides.refusedAt ?? null,
      overrides.cancelDeclinedAt ?? null,
      overrides.cancelAcknowledgedAt ?? null,
      "2026-11-11T00:00:00.000Z",
    ]
  );
}

async function expectRejected(operation: () => Promise<void>, code: string): Promise<void> {
  await client.query("SAVEPOINT rejected_write");
  try {
    await expect(operation()).rejects.toMatchObject({ code });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT rejected_write");
  }
}

describe("0227 custody proposals", () => {
  it("keeps previous payment writers compatible without adding queue columns", async () => {
    await client.query(
      "INSERT INTO payment_transfers VALUES ('old_writer', 'org', 'project', 'processing')"
    );
    await client.query("UPDATE payment_transfers SET status = 'confirmed' WHERE id = 'old_writer'");
    expect(
      (await client.query("SELECT * FROM payment_transfers WHERE id = 'old_writer'")).rows
    ).toEqual([
      { id: "old_writer", organization_id: "org", project_id: "project", status: "confirmed" },
    ]);
  });

  it("enforces exact payment and project tenant parents", async () => {
    await expectRejected(
      () => insertProposal({ organization: "other_org", project: "other_project" }),
      "23503"
    );
    await expectRejected(() => insertProposal({ project: "other_project" }), "23503");
    await insertProposal();
    expect((await client.query("SELECT payment_transfer_id FROM custody_proposals")).rows).toEqual([
      { payment_transfer_id: "payment" },
    ]);
  });

  it("rejects invalid state combinations before a worker can read them", async () => {
    await expectRejected(() => insertProposal({ phase: "not_a_phase" }), "23514");
    await expectRejected(() => insertProposal({ authorization: "refused" }), "23514");
    await expectRejected(
      () => insertProposal({ cancelDeclinedAt: "2026-11-11T00:00:00.000Z" }),
      "23514"
    );
    await expectRejected(
      () => insertProposal({ cancelAcknowledgedAt: "2026-11-11T00:00:00.000Z" }),
      "23514"
    );
    await expectRejected(() => insertProposal({ phase: "completed" }), "23514");
  });

  it("forces tenant RLS and validates the new table's foreign keys separately", async () => {
    const security = await client.query<{ enabled: boolean; forced: boolean }>(
      "SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'pg_temp.custody_proposals'::regclass"
    );
    expect(security.rows).toEqual([{ enabled: true, forced: true }]);
    const policies = await client.query(
      "SELECT polname FROM pg_policy WHERE polrelid = 'pg_temp.custody_proposals'::regclass"
    );
    expect(policies.rows).toEqual([{ polname: "sdp_tenant_isolation" }]);
    const foreignKeys = await client.query(
      "SELECT convalidated FROM pg_constraint WHERE conrelid = 'pg_temp.custody_proposals'::regclass AND contype = 'f'"
    );
    expect(foreignKeys.rows).toEqual([
      { convalidated: true },
      { convalidated: true },
      { convalidated: true },
    ]);
  });

  it("pins canonical phase/provider sets and indexes completed alerts independently", async () => {
    const constraints = await client.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'pg_temp.custody_proposals'::regclass AND contype = 'c'"
    );
    const definitions = constraints.rows.map((row) => row.definition).join("\n");
    for (const value of [
      ...CUSTODY_PROVIDERS,
      ...CUSTODY_PROPOSAL_PROVIDER_PHASES,
      ...CUSTODY_PROPOSAL_AUTHORIZATION_STATES,
    ])
      expect(definitions).toContain(`'${value}'::text`);
    const indexes = await client.query<{ indexname: string; definition: string }>(
      "SELECT c.relname AS indexname, pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = 'pg_temp.custody_proposals'::regclass"
    );
    const due = indexes.rows.find(
      (row) => row.indexname === "custody_proposals_due_idx"
    )?.definition;
    for (const phase of CUSTODY_PROPOSAL_ACTIVE_PHASES) expect(due).toContain(`'${phase}'::text`);
    const legacy = indexes.rows.find(
      (row) => row.indexname === "custody_proposals_legacy_unsent_idx"
    )?.definition;
    expect(legacy).toContain("(payment_transfer_id)");
    expect(legacy).toContain("'unsent'::text");
    expect(legacy).toContain("'authorized'::text");
    const alerts = indexes.rows.find(
      (row) => row.indexname === "custody_proposals_unalerted_idx"
    )?.definition;
    expect(alerts).toContain("'committed_after_refusal'::text");
    expect(alerts).toContain("alerted_at IS NULL");
    expect(alerts).not.toContain("provider_phase");
  });
});
