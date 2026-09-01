import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0073_private_channel_principals.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

let client: Client;

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

describe("0073_private_channel_principals legacy reconciliation", () => {
  it("resolves duplicate names and wallet owners before creating narrower indexes", async () => {
    await client.query(
      "INSERT INTO organizations (id, name, slug) VALUES ('org_0073', 'Org 0073', 'org-0073')"
    );
    await client.query(
      `INSERT INTO users (id, email) VALUES
         ('usr_0073', 'owner-0073@example.test')`
    );
    await client.query(
      `INSERT INTO projects (id, organization_id, name, slug, created_by)
       VALUES ('prj_0073', 'org_0073', 'Project 0073', 'project-0073', 'usr_0073')`
    );
    await client.query(
      `INSERT INTO private_channel_instances (
         id, organization_id, project_id, gateway_url, escrow_program_id,
         withdraw_program_id, escrow_instance_addr, auth_url, is_active
       ) VALUES (
         'pci_0073', 'org_0073', 'prj_0073', 'http://gateway-0073.test',
         'escrow', 'withdraw', 'instance', 'http://auth-0073.test', TRUE
       )`
    );

    // Recreate the valid pre-0073 state: duplicate display names and one pubkey
    // verified under more than one legacy SDP user.
    await client.query("DROP INDEX private_channel_principals_name_key");
    await client.query("DROP INDEX private_channel_principals_default_key");
    await client.query("DROP INDEX private_channel_verified_wallets_instance_pubkey_key");
    await client.query(
      `INSERT INTO private_channel_users (
         id, organization_id, project_id, user_id, instance_id, name, is_default, created_at
       ) VALUES
         ('pcu_0073_default', 'org_0073', 'prj_0073', NULL, 'pci_0073', 'Owner', FALSE, '2026-01-01T00:00:00.000Z'),
         ('pcu_0073_a', 'org_0073', 'prj_0073', NULL, 'pci_0073', 'Treasury', FALSE, '2026-01-02T00:00:00.000Z'),
         ('pcu_0073_b', 'org_0073', 'prj_0073', NULL, 'pci_0073', 'Treasury', FALSE, '2026-01-03T00:00:00.000Z')`
    );
    await client.query(
      `INSERT INTO private_channel_verified_wallets (
         id, organization_id, project_id, user_id, instance_id, wallet_id, pubkey
       ) VALUES
         ('pcvw_0073_default', 'org_0073', 'prj_0073', 'pcu_0073_default', 'pci_0073', 'wal_default', 'shared_pubkey'),
         ('pcvw_0073_other', 'org_0073', 'prj_0073', 'pcu_0073_a', 'pci_0073', 'wal_other', 'shared_pubkey')`
    );

    await expect(client.query(migrationSql)).resolves.toBeDefined();

    const identities = await client.query<{ id: string; name: string; is_default: boolean }>(
      `SELECT id, name, is_default
         FROM private_channel_users
        WHERE project_id = 'prj_0073'
        ORDER BY id`
    );
    expect(identities.rows).toEqual([
      { id: "pcu_0073_a", name: "Treasury", is_default: false },
      { id: "pcu_0073_b", name: "Treasury · pcu_0073_b", is_default: false },
      { id: "pcu_0073_default", name: "Default", is_default: true },
    ]);

    const wallets = await client.query<{ user_id: string }>(
      "SELECT user_id FROM private_channel_verified_wallets WHERE pubkey = 'shared_pubkey'"
    );
    expect(wallets.rows).toEqual([{ user_id: "pcu_0073_default" }]);

    const indexes = await client.query<{ index_name: string; predicate: string }>(
      `SELECT indexrelid::regclass::text AS index_name,
              pg_get_expr(indpred, indrelid) AS predicate
         FROM pg_index
        WHERE indexrelid IN (
          'private_channel_principals_default_key'::regclass,
          'private_channel_principals_name_key'::regclass
        )
        ORDER BY index_name`
    );
    expect(indexes.rows).toHaveLength(2);
    expect(
      indexes.rows.every(({ predicate }) => predicate.includes("instance_id IS NOT NULL"))
    ).toBe(true);
  });
});
