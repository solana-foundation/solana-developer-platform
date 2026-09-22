import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0114b_bvnk_offramp_provider_data.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");
let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  await client.query("SET app.tenant_isolation_identity = 'system'");
});

afterAll(async () => {
  await client.end();
});

describe("0114b BVNK off-ramp provider data removal", () => {
  it("removes provider_data.bvnk.offramp and keeps the rest of the bvnk payload", async () => {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ('org_0114b', 'Org 0114b', 'org-0114b')`
    );
    await client.query(
      `INSERT INTO users (id, email) VALUES ('usr_0114b', 'owner-0114b@example.test')`
    );
    await client.query(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
       VALUES ('prj_0114b', 'org_0114b', 'Default Sandbox Project', 'default-sandbox', 'sandbox', 'active', 'usr_0114b')`
    );
    await client.query(
      `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name, provider_data)
       VALUES
         ('cpty_0114b_with', 'org_0114b', 'prj_0114b', 'individual', 'With Offramp', '{"bvnk":{"offramp":{"wallets":{"USD":{"id":"a:1:wallet:1","status":"ACTIVE"}}},"customer":{"reference":"bvnk_0114b"}}}'),
         ('cpty_0114b_without', 'org_0114b', 'prj_0114b', 'individual', 'Without Offramp', '{"bvnk":{"customer":{"reference":"bvnk_0114b_other"}}}')`
    );

    await client.query(migrationSql);

    const rows = await client.query<{ id: string; provider_data: Record<string, unknown> }>(
      `SELECT id, provider_data FROM counterparties WHERE id LIKE 'cpty_0114b_%' ORDER BY id`
    );
    expect(rows.rows).toEqual([
      { id: "cpty_0114b_with", provider_data: { bvnk: { customer: { reference: "bvnk_0114b" } } } },
      {
        id: "cpty_0114b_without",
        provider_data: { bvnk: { customer: { reference: "bvnk_0114b_other" } } },
      },
    ]);
    await client.query("ROLLBACK");
  });
});
