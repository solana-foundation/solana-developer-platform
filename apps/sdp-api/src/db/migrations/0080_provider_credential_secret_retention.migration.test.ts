import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const ORGANIZATION_ID = "org_credential_secret_retention";
const USER_ID = "usr_credential_secret_retention";

async function insertCredential(params: {
  id: string;
  status: "pending" | "active" | "failed_validation" | "retired" | "deactivated";
  backend?: "encrypted_db" | "runtime_env";
  ciphertext?: string | null;
  retentionExpiresAt?: string | null;
}): Promise<void> {
  const backend = params.backend ?? "encrypted_db";
  const runtime = backend === "runtime_env";
  await getDb(env)
    .prepare(
      `INSERT INTO provider_credentials (
         id, organization_id, provider, label, scope, source, storage_backend,
         encrypted_secret_payload, status, deactivated_at,
         secret_retention_expires_at, created_by
       ) VALUES (?, ?, 'privy', 'Privy', 'organization', ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.id,
      ORGANIZATION_ID,
      runtime ? "runtime" : "stored",
      backend,
      runtime ? null : (params.ciphertext ?? null),
      params.status,
      params.status === "deactivated" ? "2026-09-04T10:00:00.000Z" : null,
      params.retentionExpiresAt ?? null,
      USER_ID
    )
    .run();
}

describe("0080 provider Credential secret retention", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env)
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Credential retention', 'credential-retention', 'enterprise', 'active')`
      )
      .bind(ORGANIZATION_ID)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'credential-retention@example.test', 1, 'active')`
      )
      .bind(USER_ID)
      .run();
  });

  it("requires ciphertext while a retired encrypted-db Credential is rollback-retained", async () => {
    await expect(
      insertCredential({
        id: "pcred_retained_without_secret",
        status: "retired",
        retentionExpiresAt: "2026-09-05T10:00:00.000Z",
      })
    ).rejects.toThrow(/provider_credentials_secret_location_check/);

    await expect(
      insertCredential({
        id: "pcred_retained_with_secret",
        status: "retired",
        ciphertext: "v2.ciphertext",
        retentionExpiresAt: "2026-09-05T10:00:00.000Z",
      })
    ).resolves.toBeUndefined();
  });

  it("allows cleanup to atomically clear the ciphertext and retention marker", async () => {
    await insertCredential({
      id: "pcred_cleanup",
      status: "retired",
      ciphertext: "v2.ciphertext",
      retentionExpiresAt: "2026-09-05T10:00:00.000Z",
    });

    await expect(
      getDb(env)
        .prepare(
          `UPDATE provider_credentials
           SET encrypted_secret_payload = NULL,
               secret_retention_expires_at = NULL
           WHERE id = ?`
        )
        .bind("pcred_cleanup")
        .run()
    ).resolves.toBe(1);
  });

  it("keeps pre-existing retired metadata without a retention marker valid", async () => {
    await expect(
      insertCredential({ id: "pcred_rpc_history", status: "retired" })
    ).resolves.toBeUndefined();
  });

  it("permits a retention marker only on a stored retired Credential", async () => {
    await expect(
      insertCredential({
        id: "pcred_active_marker",
        status: "active",
        ciphertext: "v2.ciphertext",
        retentionExpiresAt: "2026-09-05T10:00:00.000Z",
      })
    ).rejects.toThrow(/provider_credentials_secret_retention_check/);

    await expect(
      insertCredential({
        id: "pcred_runtime_marker",
        status: "retired",
        backend: "runtime_env",
        retentionExpiresAt: "2026-09-05T10:00:00.000Z",
      })
    ).rejects.toThrow(/provider_credentials_secret_retention_check/);
  });
});
