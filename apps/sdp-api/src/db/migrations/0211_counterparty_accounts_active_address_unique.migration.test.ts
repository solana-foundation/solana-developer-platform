import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CounterpartyAccountStatus } from "@sdp/types/counterparties";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import { seedCounterparty, seedOrgProject, UNIQUE_VIOLATION } from "@/test/helpers/migration-db";

const INDEX = "counterparty_accounts_active_address_unique";
const ADDRESS_A = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const ADDRESS_B = "7gECWiqwsV1Cuyk7XpMS2ngwhgbboNtWjqqYyGs4qMHZ";

function readMigration(file: string) {
  return readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres", file),
    "utf8"
  );
}

// The test runs inside a transaction, where CONCURRENTLY is not allowed; the
// index definition is otherwise the migration's own.
const buildIndex = readMigration("0211_counterparty_accounts_active_address_unique.sql").replace(
  "INDEX CONCURRENTLY",
  "INDEX"
);

let client: Client;
let tenant: Awaited<ReturnType<typeof seedOrgProject>>;

async function insertAccount(row: {
  id: string;
  counterpartyId?: string;
  address: string;
  status?: CounterpartyAccountStatus;
  createdAt: string;
  /** Pre-0036 rows carry the address only in `details`. */
  detailsOnly?: boolean;
}) {
  return client.query(
    `INSERT INTO counterparty_accounts (
       id, organization_id, project_id, counterparty_id, account_kind, details,
       network, address, status, created_at
     ) VALUES ($1, $2, $3, $4, 'crypto_wallet', $5, $6, $7, $8, $9)`,
    [
      row.id,
      tenant.organizationId,
      tenant.projectId,
      row.counterpartyId ?? "cpty_0211",
      { network: "solana", address: row.address },
      row.detailsOnly ? null : "solana",
      row.detailsOnly ? null : row.address,
      row.status ?? "active",
      row.createdAt,
    ]
  );
}

async function statuses() {
  const { rows } = await client.query<{ id: string; status: CounterpartyAccountStatus }>(
    "SELECT id, status FROM counterparty_accounts WHERE organization_id = $1 ORDER BY id",
    [tenant.organizationId]
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
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
  await client.query(`DROP INDEX ${INDEX}`);
  tenant = await seedOrgProject(client, "0211");
  for (const id of ["cpty_0211", "cpty_0211_other"]) {
    await seedCounterparty(client, {
      id,
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });
  }
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0211 one active account per counterparty address", () => {
  it("refuses a second active account for one address, details-only rows included", async () => {
    await client.query(buildIndex);
    await insertAccount({ id: "cpa_first", address: ADDRESS_A, createdAt: "2026-10-01T00:00:00Z" });

    // Pre-0036 rows carry the address only in details: still the same key.
    for (const detailsOnly of [false, true]) {
      await client.query("SAVEPOINT probe");
      await expect(
        insertAccount({
          id: "cpa_dup",
          address: ADDRESS_A,
          createdAt: "2026-10-02T00:00:00Z",
          detailsOnly,
        })
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION, constraint: INDEX });
      await client.query("ROLLBACK TO SAVEPOINT probe");
    }
  });

  it("allows archived accounts, other addresses and other counterparties", async () => {
    await client.query(buildIndex);
    await insertAccount({ id: "cpa_first", address: ADDRESS_A, createdAt: "2026-10-01T00:00:00Z" });
    await insertAccount({
      id: "cpa_archived",
      address: ADDRESS_A,
      status: "archived",
      createdAt: "2026-09-01T00:00:00Z",
    });
    await insertAccount({
      id: "cpa_other_address",
      address: ADDRESS_B,
      createdAt: "2026-10-04T00:00:00Z",
    });
    await insertAccount({
      id: "cpa_other_counterparty",
      counterpartyId: "cpty_0211_other",
      address: ADDRESS_A,
      createdAt: "2026-10-05T00:00:00Z",
    });

    // Archiving frees the address for a new account.
    await client.query(
      "UPDATE counterparty_accounts SET status = 'archived' WHERE id = 'cpa_first'"
    );
    await insertAccount({
      id: "cpa_readded",
      address: ADDRESS_A,
      createdAt: "2026-11-02T00:00:00Z",
    });

    expect(await statuses()).toEqual({
      cpa_archived: "archived",
      cpa_first: "archived",
      cpa_other_address: "active",
      cpa_other_counterparty: "active",
      cpa_readded: "active",
    });
  });
});
