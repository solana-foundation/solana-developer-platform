import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl as databaseUrl, env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  runPostgresMigrations,
  splitSqlStatements,
} from "../../../scripts/lib/run-postgres-migrations.mjs";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const migrationFile = "0085_provider_credential_deactivation_cleanup.sql";
const previousRetentionCheck = splitSqlStatements(
  readFileSync(path.join(migrationsDir, "0082_provider_credential_creation.sql"), "utf8")
).find((statement: string) =>
  statement.includes("ADD CONSTRAINT provider_credentials_secret_retention_check")
);
const retentionExpiresAt = "2026-09-05T10:00:00.000Z";
let client: Client;

async function insertCredential(params: {
  id: string;
  status: "creating" | "pending" | "active" | "failed_validation" | "retired" | "deactivated";
  backend?: "encrypted_db" | "gcp_secret_manager" | "runtime_env";
  retained?: boolean;
  predecessor?: string;
  abandoned?: boolean;
}): Promise<void> {
  const backend = params.backend ?? "gcp_secret_manager";
  const gcp = backend === "gcp_secret_manager";
  await client.query(
    `INSERT INTO provider_credentials (
       id, organization_id, provider, label, scope, source, storage_backend,
       secret_ref, secret_version_ref, encrypted_secret_payload, status,
       deactivated_at, secret_retention_expires_at, rotated_from_provider_credential_id,
       last_failure_code, created_by
     ) VALUES ($1, 'org_cleanup_0085', 'privy', 'Privy', 'organization', $2, $3,
       $4, $5, $6, $7, $8, $9, $10, $11, 'usr_cleanup_0085')`,
    [
      params.id,
      backend === "runtime_env" ? "runtime" : "stored",
      backend,
      gcp ? `projects/p/secrets/${params.id}` : null,
      gcp && params.status !== "creating" && !params.abandoned
        ? `projects/p/secrets/${params.id}/versions/7`
        : null,
      backend === "encrypted_db" ? "v2.ciphertext" : null,
      params.status,
      params.status === "deactivated" ? retentionExpiresAt : null,
      params.retained ? retentionExpiresAt : null,
      params.predecessor ?? null,
      params.abandoned ? "secret_creation_abandoned" : null,
    ]
  );
}

describe("0085 provider Credential deactivation cleanup", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  beforeEach(async () => {
    await seedTestDatabase(env);
    await client.query(
      "INSERT INTO organizations (id, name, slug) VALUES ('org_cleanup_0085', 'Cleanup', 'cleanup-0085')"
    );
    await client.query(
      "INSERT INTO users (id, email) VALUES ('usr_cleanup_0085', 'cleanup-0085@example.test')"
    );
  });

  afterEach(async () => {
    await runPostgresMigrations({ databaseUrl, migrationsDir });
  });

  afterAll(async () => {
    await client.end();
  });

  it("preserves A's rows without backfill and admits an explicitly deactivated root marker", async () => {
    if (!previousRetentionCheck) throw new Error("Missing 0082 retention constraint");
    await client.query(
      `ALTER TABLE provider_credentials DROP CONSTRAINT provider_credentials_secret_retention_check; ${previousRetentionCheck}`
    );
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [migrationFile]);
    await insertCredential({ id: "pcred_predecessor_0085", status: "active" });
    for (const status of ["failed_validation", "deactivated"] as const) {
      await insertCredential({ id: `pcred_root_${status}_0085`, status });
      await insertCredential({
        id: `pcred_candidate_${status}_0085`,
        status,
        retained: true,
        predecessor: "pcred_predecessor_0085",
      });
    }
    for (const backend of ["encrypted_db", "gcp_secret_manager"] as const) {
      await insertCredential({
        id: `pcred_retired_${backend}_0085`,
        status: "retired",
        backend,
        retained: true,
      });
    }
    await insertCredential({ id: "pcred_creating_0085", status: "creating" });
    await insertCredential({
      id: "pcred_abandoned_root_0085",
      status: "deactivated",
      retained: true,
      abandoned: true,
    });
    await client.query(
      `UPDATE provider_credentials
       SET secret_cleanup_attempt_count = 2, secret_cleanup_next_attempt_at = $1,
           secret_cleanup_absent_since = $1, secret_next_scan_at = $1::text::timestamptz
       WHERE id = 'pcred_abandoned_root_0085'`,
      [retentionExpiresAt]
    );
    const before = await client.query("SELECT * FROM provider_credentials ORDER BY id");
    await expect(
      client.query(
        "UPDATE provider_credentials SET secret_retention_expires_at = $1 WHERE id = 'pcred_root_deactivated_0085'",
        [retentionExpiresAt]
      )
    ).rejects.toMatchObject({ constraint: "provider_credentials_secret_retention_check" });

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    expect((await client.query("SELECT * FROM provider_credentials ORDER BY id")).rows).toEqual(
      before.rows
    );
    await expect(
      client.query(
        "UPDATE provider_credentials SET secret_retention_expires_at = $1 WHERE id = 'pcred_root_deactivated_0085'",
        [retentionExpiresAt]
      )
    ).resolves.toMatchObject({ rowCount: 1 });
    await runPostgresMigrations({ databaseUrl, migrationsDir });
    expect(
      (
        await client.query(
          "SELECT status, secret_retention_expires_at FROM provider_credentials WHERE id = 'pcred_root_deactivated_0085'"
        )
      ).rows
    ).toEqual([{ status: "deactivated", secret_retention_expires_at: retentionExpiresAt }]);
  });

  it("admits a deactivated GCP root marker on the freshly migrated schema", async () => {
    await expect(
      insertCredential({ id: "pcred_deactivated_root_0085", status: "deactivated", retained: true })
    ).resolves.toBeUndefined();
  });

  it.each([
    { status: "failed_validation", backend: "gcp_secret_manager" },
    { status: "creating", backend: "gcp_secret_manager" },
    { status: "pending", backend: "gcp_secret_manager" },
    { status: "active", backend: "gcp_secret_manager" },
    { status: "deactivated", backend: "encrypted_db" },
    { status: "deactivated", backend: "runtime_env" },
  ] as const)(
    "rejects a root cleanup marker for $status / $backend",
    async ({ status, backend }) => {
      await expect(
        insertCredential({ id: "pcred_rejected_0085", status, backend, retained: true })
      ).rejects.toMatchObject({ constraint: "provider_credentials_secret_retention_check" });
    }
  );
});
