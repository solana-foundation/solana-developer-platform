/**
 * Migration contract for 0119_issuance_create_idempotency (APE-719 / SOLA9-195).
 *
 * The creation-idempotency record must be claimable exactly once per
 * (organization, project, scope, key), be bound to its token by a cascading
 * composite foreign key, reject unknown scopes, and stay tenant-isolated by
 * forced row-level security.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0119_issuance_create_idempotency.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

const ORG_A = "org_idem_a";
const ORG_B = "org_idem_b";
const PROJECT_A = "prj_idem_a";
const TOKEN_A = "tok_idem_a";

let client: Client;

async function seedTenantFixtures(): Promise<void> {
  // TRUNCATE ... CASCADE keeps the fixture self-contained per case.
  await client.query(
    "TRUNCATE issuance_create_idempotency, issued_tokens, projects, organizations CASCADE"
  );
  await client.query(
    `INSERT INTO organizations (id, name, slug, tier, status)
     VALUES ($1, 'Idem A', 'idem-a', 'individual', 'active'),
            ($2, 'Idem B', 'idem-b', 'individual', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [ORG_A, ORG_B]
  );
  await client.query(
    `INSERT INTO users (id, email, email_verified, status)
     VALUES ('user_idem', 'idem@example.test', 1, 'active')
     ON CONFLICT (id) DO NOTHING`
  );
  await client.query(
    `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Idem Project A', 'idem-project-a', 'sandbox', 'active', 'user_idem', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [PROJECT_A, ORG_A]
  );
  await client.query(
    `INSERT INTO issued_tokens (id, project_id, organization_id, name, symbol, created_by)
     VALUES ($1, $2, $3, 'Idem Token', 'IDM', 'user_idem')`,
    [TOKEN_A, PROJECT_A, ORG_A]
  );
}

async function insertRecord(overrides: Record<string, unknown> = {}): Promise<void> {
  await client.query(
    `INSERT INTO issuance_create_idempotency
       (id, organization_id, project_id, scope, idempotency_key, request_fingerprint, token_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      overrides.id ?? "ici_one",
      overrides.organizationId ?? ORG_A,
      overrides.projectId ?? PROJECT_A,
      overrides.scope ?? "token_create",
      overrides.idempotencyKey ?? "key-1",
      overrides.requestFingerprint ?? '{"body":{"name":"a"}}',
      overrides.tokenId ?? TOKEN_A,
    ]
  );
}

describe("0119_issuance_create_idempotency", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    await client.query("SET app.tenant_isolation_identity = 'system'");
    // Idempotently apply the migration body so this test also proves the SQL
    // runs clean on a database that already has it.
    await client.query(migrationSql);
  });

  beforeEach(async () => {
    await seedTenantFixtures();
  });

  afterAll(async () => {
    await client.query(
      "TRUNCATE issuance_create_idempotency, issued_tokens, projects, organizations CASCADE"
    );
    await client.end();
  });

  it("keeps the migration idempotent on re-run", async () => {
    // Re-running every statement must not fail (IF NOT EXISTS everywhere).
    await expect(client.query(migrationSql)).resolves.toBeDefined();
  });

  it("claims a key exactly once per tenant, project, and scope", async () => {
    await insertRecord();
    await expect(insertRecord()).rejects.toMatchObject({ code: "23505" });
    // Same key in the sibling creation scope is a different claim.
    await insertRecord({ id: "ici_two", scope: "asset_profile_create" });
    // Same key for another tenant is a different claim.
    await client.query(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by, created_at, updated_at)
       VALUES ('prj_idem_b', $1, 'Idem Project B', 'idem-project-b', 'sandbox', 'active', 'user_idem', now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [ORG_B]
    );
    await client.query(
      `INSERT INTO issued_tokens (id, project_id, organization_id, name, symbol, created_by)
       VALUES ('tok_idem_b', 'prj_idem_b', $1, 'Idem Token B', 'IDB', 'user_idem')`,
      [ORG_B]
    );
    await insertRecord({
      id: "ici_three",
      organizationId: ORG_B,
      projectId: "prj_idem_b",
      tokenId: "tok_idem_b",
    });
  });

  it("rejects an unknown scope", async () => {
    await expect(
      insertRecord({ id: "ici_bad_scope", scope: "unknown_scope" })
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("cascade-deletes the record with its token", async () => {
    await insertRecord({ id: "ici_cascade" });
    await client.query("DELETE FROM issued_tokens WHERE id = $1", [TOKEN_A]);
    const remaining = await client.query(
      "SELECT COUNT(*)::int AS count FROM issuance_create_idempotency"
    );
    expect(remaining.rows[0]).toEqual({ count: 0 });
  });

  it("stays hidden from, and unwritable by, a foreign tenant identity", async () => {
    await insertRecord({ id: "ici_rls" });

    await client.query("SET app.tenant_isolation_identity = 'tenant'");
    await client.query(`SET app.tenant_isolation_organization_id = '${ORG_B}'`);

    const visible = await client.query("SELECT id FROM issuance_create_idempotency");
    expect(visible.rows).toEqual([]);

    await expect(insertRecord({ id: "ici_rls_write" })).rejects.toMatchObject({ code: "42501" });

    await client.query(`SET app.tenant_isolation_organization_id = '${ORG_A}'`);
    const own = await client.query("SELECT id FROM issuance_create_idempotency");
    expect(own.rows).toEqual([{ id: "ici_rls" }]);
  });
});
