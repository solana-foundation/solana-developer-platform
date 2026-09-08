import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { rootLogger } from "@/runtime/logger";
import type { CredentialSecretStore } from "@/services/credential-secret-store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { cleanupRetiredProviderCredentialSecrets } from "./cleanup-provider-credential-secrets";

const createCredentialSecretStore = vi.hoisted(() => vi.fn());
const destroyVersion = vi.hoisted(() => vi.fn());
const listVersions = vi.hoisted(() => vi.fn());

vi.mock("@/services/credential-secret-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/credential-secret-store")>()),
  createCredentialSecretStore,
}));

const ORGANIZATION_ID = "org_credential_cleanup";
const PROJECT_ID = "prj_credential_cleanup";
const USER_ID = "usr_credential_cleanup";

async function insertCredential(params: {
  id: string;
  status?: "creating" | "pending" | "active" | "failed_validation" | "retired" | "deactivated";
  backend?: "encrypted_db" | "gcp_secret_manager";
  retentionExpiresAt?: string | null;
  rotatedFromId?: string | null;
  createdAt?: string;
}): Promise<void> {
  const backend = params.backend ?? "encrypted_db";
  const status = params.status ?? "retired";
  const gcp = backend === "gcp_secret_manager";
  await getDb(env)
    .prepare(
      `INSERT INTO provider_credentials (
         id, organization_id, provider, label, scope, source, storage_backend,
         secret_ref, secret_version_ref, encrypted_secret_payload, status,
         rotated_from_provider_credential_id, secret_retention_expires_at,
         deactivated_at, created_by, created_at, secret_next_scan_at
       ) VALUES (
         ?, ?, 'privy', 'Privy', 'organization', 'stored', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz
       )`
    )
    .bind(
      params.id,
      ORGANIZATION_ID,
      backend,
      gcp ? `projects/p/secrets/sdp-provider-credentials-${params.id}` : null,
      gcp && status !== "creating"
        ? `projects/p/secrets/sdp-provider-credentials-${params.id}/versions/7`
        : null,
      gcp ? null : "v2.ciphertext",
      status,
      params.rotatedFromId ?? null,
      params.retentionExpiresAt ?? null,
      status === "deactivated" ? "2026-09-04T10:00:00.000Z" : null,
      USER_ID,
      params.createdAt ?? new Date().toISOString(),
      gcp ? "2020-01-01T00:00:00.000Z" : null
    )
    .run();
}

async function credentialState(id: string): Promise<{
  status: string;
  encrypted_secret_payload: string | null;
  secret_retention_expires_at: string | null;
}> {
  const row = await getDb(env)
    .prepare(
      `SELECT status, encrypted_secret_payload, secret_retention_expires_at
       FROM provider_credentials WHERE id = ?`
    )
    .bind(id)
    .first<{
      status: string;
      encrypted_secret_payload: string | null;
      secret_retention_expires_at: string | null;
    }>();
  if (!row) throw new Error(`Missing test Credential: ${id}`);
  return row;
}

async function makeCleanupDue(id: string): Promise<void> {
  await getDb(env).execute(
    "UPDATE provider_credentials SET secret_next_scan_at = clock_timestamp() - interval '1 second' WHERE id = ?",
    [id]
  );
}

async function insertConnection(id: string, credentialId: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_connections (
         id, organization_id, project_id, provider, scope, provider_credential_id,
         provider_credential_scope_key, status, created_by
       ) VALUES (?, ?, ?, 'privy', 'project', ?, '__organization__', 'pending', ?)`
    )
    .bind(id, ORGANIZATION_ID, PROJECT_ID, credentialId, USER_ID)
    .run();
}

describe("cleanupRetiredProviderCredentialSecrets", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    createCredentialSecretStore.mockReset().mockReturnValue({
      predictFirstVersionRef: () => null,
      storageBackend: "gcp_secret_manager",
      write: vi.fn(),
      read: vi.fn(),
      destroyVersion: destroyVersion.mockReset().mockResolvedValue(undefined),
      listVersions: listVersions.mockReset().mockResolvedValue({ versions: [] }),
    } satisfies CredentialSecretStore);
    await seedTestDatabase(env);
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO organizations (id, name, slug, tier, status)
           VALUES (?, 'Credential cleanup', 'credential-cleanup', 'enterprise', 'active')`
        )
        .bind(ORGANIZATION_ID),
      getDb(env)
        .prepare(
          `INSERT INTO users (id, email, email_verified, status)
           VALUES (?, 'credential-cleanup@example.test', 1, 'active')`
        )
        .bind(USER_ID),
      getDb(env)
        .prepare(
          `INSERT INTO projects
             (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Credential cleanup', 'credential-cleanup', 'sandbox', 'active', ?)`
        )
        .bind(PROJECT_ID, ORGANIZATION_ID, USER_ID),
    ]);
  });

  it("does not start cleanup when the shared deadline has already expired", async () => {
    const logWarning = vi.spyOn(rootLogger, "warn").mockImplementation(() => rootLogger);
    await insertCredential({
      id: "pcred_no_budget",
      backend: "gcp_secret_manager",
      retentionExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    await expect(
      cleanupRetiredProviderCredentialSecrets(env, {
        deadlineMs: performance.now() - 1,
      })
    ).resolves.toMatchObject({ cleaned: 0, deadlineReached: true });
    expect(destroyVersion).not.toHaveBeenCalled();
    expect(logWarning).not.toHaveBeenCalled();
    expect((await credentialState("pcred_no_budget")).secret_retention_expires_at).not.toBeNull();
  });

  it("retries destruction after failed initial validation despite its failed connection", async () => {
    const id = "pcred_rejected_initial";
    const versionRef = `projects/p/secrets/sdp-provider-credentials-${id}/versions/7`;
    await insertCredential({ id, status: "failed_validation", backend: "gcp_secret_manager" });
    await insertConnection("ccn_rejected_initial", id);
    await getDb(env).execute(
      "UPDATE custody_connections SET status = 'failed', last_check_status = 'failed', last_check_at = sdp_iso_now(), last_check_failure_code = 'invalid_credentials' WHERE id = ?",
      ["ccn_rejected_initial"]
    );
    listVersions.mockResolvedValue({
      versions: [{ secretVersionRef: versionRef, state: "ENABLED" }],
    });

    await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toMatchObject({
      cleaned: 1,
    });
    expect(destroyVersion).toHaveBeenCalledExactlyOnceWith({
      secretVersionRef: versionRef,
      signal: expect.any(AbortSignal),
      requireDestroyed: true,
    });
  });

  it("defers a slow in-flight deletion and the rest of the batch without losing work", async () => {
    const logWarning = vi.spyOn(rootLogger, "warn").mockImplementation(() => rootLogger);
    for (const id of ["pcred_budget_first", "pcred_budget_second"]) {
      await insertCredential({
        id,
        backend: "gcp_secret_manager",
        retentionExpiresAt: "2020-01-01T00:00:00.000Z",
      });
    }
    destroyVersion.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );
    await expect(
      cleanupRetiredProviderCredentialSecrets(env, {
        deadlineMs: performance.now() + 500,
      })
    ).resolves.toMatchObject({ cleaned: 0, failed: 0, deferred: 2, deadlineReached: true });
    expect(destroyVersion).toHaveBeenCalledOnce();
    expect(logWarning).toHaveBeenCalledWith(
      {
        organizationId: ORGANIZATION_ID,
        containerOwnerCredentialId: "pcred_budget_first",
        provider: "privy",
        storageBackend: "gcp_secret_manager",
        reason: "cleanup_deadline_reached",
        outcome: "scan_incomplete",
      },
      "provider_credential_cleanup_interrupted"
    );
    expect(logWarning).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        secretVersionRef:
          "projects/p/secrets/sdp-provider-credentials-pcred_budget_first/versions/7",
        outcome: "destruction_unconfirmed",
      }),
      "provider_credential_secret_destruction_unconfirmed"
    );
    expect(
      (await credentialState("pcred_budget_first")).secret_retention_expires_at
    ).not.toBeNull();
    expect(
      (await credentialState("pcred_budget_second")).secret_retention_expires_at
    ).not.toBeNull();

    await makeCleanupDue("pcred_budget_first");
    await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toMatchObject({
      cleaned: 2,
    });
  });

  it("atomically clears an expired encrypted-db secret and its retention marker", async () => {
    await insertCredential({
      id: "pcred_expired_encrypted",
      retentionExpiresAt: "2020-01-01T00:00:00.000Z",
    });

    await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toEqual({
      cleaned: 1,
      skipped: 0,
      failed: 0,
    });
    await expect(credentialState("pcred_expired_encrypted")).resolves.toEqual({
      status: "retired",
      encrypted_secret_payload: null,
      secret_retention_expires_at: null,
    });
    expect(createCredentialSecretStore).not.toHaveBeenCalled();
  });

  it("retains a future rollback target only while its direct child is active", async () => {
    await insertCredential({
      id: "pcred_future_predecessor",
      retentionExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    await insertCredential({
      id: "pcred_active_child",
      status: "active",
      rotatedFromId: "pcred_future_predecessor",
    });

    await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toEqual({
      cleaned: 0,
      skipped: 0,
      failed: 0,
    });
    expect((await credentialState("pcred_future_predecessor")).encrypted_secret_payload).toBe(
      "v2.ciphertext"
    );

    await getDb(env)
      .prepare(
        `UPDATE provider_credentials
         SET status = 'deactivated', deactivated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind("pcred_active_child")
      .run();

    await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toEqual({
      cleaned: 1,
      skipped: 0,
      failed: 0,
    });
    expect((await credentialState("pcred_future_predecessor")).encrypted_secret_payload).toBeNull();
  });

  it("cleans an expired predecessor even while its direct child is active", async () => {
    await insertCredential({
      id: "pcred_expired_predecessor",
      retentionExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    await insertCredential({
      id: "pcred_current_child",
      status: "active",
      rotatedFromId: "pcred_expired_predecessor",
    });

    await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toEqual({
      cleaned: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it("does not clean a credential referenced by a non-deactivated connection", async () => {
    await insertCredential({
      id: "pcred_still_referenced",
      retentionExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    await getDb(env)
      .prepare(
        `INSERT INTO custody_connections (
           id, organization_id, project_id, provider, scope, provider_credential_id,
           provider_credential_scope_key, status, created_by
         ) VALUES (?, ?, ?, 'privy', 'project', ?, '__organization__', 'pending', ?)`
      )
      .bind(
        "conn_credential_cleanup",
        ORGANIZATION_ID,
        PROJECT_ID,
        "pcred_still_referenced",
        USER_ID
      )
      .run();

    await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toEqual({
      cleaned: 0,
      skipped: 0,
      failed: 0,
    });
    expect((await credentialState("pcred_still_referenced")).encrypted_secret_payload).toBe(
      "v2.ciphertext"
    );
  });

  it("destroys the exact GCP version before clearing the retention marker", async () => {
    await insertCredential({
      id: "pcred_expired_gcp",
      backend: "gcp_secret_manager",
      retentionExpiresAt: "2020-01-01T00:00:00.000Z",
    });

    await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toEqual({
      cleaned: 1,
      skipped: 0,
      failed: 0,
    });
    expect(createCredentialSecretStore).toHaveBeenCalledOnce();
    expect(createCredentialSecretStore).toHaveBeenCalledWith(env, "gcp_secret_manager");
    expect(destroyVersion).toHaveBeenCalledWith({
      secretVersionRef: "projects/p/secrets/sdp-provider-credentials-pcred_expired_gcp/versions/7",
      signal: expect.any(AbortSignal),
      requireDestroyed: true,
    });
    expect((await credentialState("pcred_expired_gcp")).secret_retention_expires_at).toBeNull();
  });

  it("isolates GCP failures, keeps their marker, and rejects once with redacted telemetry", async () => {
    const rawFailure =
      "raw upstream detail for projects/p/secrets/sdp-provider-credentials-pcred_a_failure/versions/7";
    destroyVersion.mockRejectedValueOnce(new Error(rawFailure)).mockResolvedValueOnce(undefined);
    const logError = vi.spyOn(rootLogger, "error").mockImplementation(() => rootLogger);
    await insertCredential({
      id: "pcred_a_failure",
      backend: "gcp_secret_manager",
      retentionExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    await insertCredential({
      id: "pcred_b_success",
      backend: "gcp_secret_manager",
      retentionExpiresAt: "2020-01-01T00:00:00.000Z",
    });

    await expect(cleanupRetiredProviderCredentialSecrets(env)).rejects.toThrow(
      "Provider Credential secret cleanup failed for 1 row(s)"
    );

    expect(destroyVersion).toHaveBeenCalledTimes(2);
    expect(createCredentialSecretStore).toHaveBeenCalledOnce();
    expect((await credentialState("pcred_a_failure")).secret_retention_expires_at).not.toBeNull();
    expect((await credentialState("pcred_b_success")).secret_retention_expires_at).toBeNull();
    expect(logError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        containerOwnerCredentialId: "pcred_a_failure",
        provider: "privy",
        storageBackend: "gcp_secret_manager",
        secretVersionRef: "projects/p/secrets/sdp-provider-credentials-pcred_a_failure/versions/7",
        reason: "secret_cleanup_failed",
      }),
      "provider_credential_orphan_risk"
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain(rawFailure);
    expect(JSON.stringify(logError.mock.calls)).not.toContain("raw upstream detail");
  });

  it("does not clear a GCP marker that changed while the destroy was in flight", async () => {
    await insertCredential({
      id: "pcred_gcp_cas",
      backend: "gcp_secret_manager",
      retentionExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    destroyVersion.mockImplementationOnce(async () => {
      await getDb(env)
        .prepare(`UPDATE provider_credentials SET secret_retention_expires_at = ? WHERE id = ?`)
        .bind("2020-01-02T00:00:00.000Z", "pcred_gcp_cas")
        .run();
    });

    await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toEqual({
      cleaned: 0,
      skipped: 1,
      failed: 0,
    });
    expect((await credentialState("pcred_gcp_cas")).secret_retention_expires_at).toBe(
      "2020-01-02T00:00:00.000Z"
    );
  });

  it("processes at most 25 rows per tick", async () => {
    for (let index = 0; index < 26; index += 1) {
      await insertCredential({
        id: `pcred_batch_${index.toString().padStart(2, "0")}`,
        retentionExpiresAt: "2020-01-01T00:00:00.000Z",
      });
    }

    await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toEqual({
      cleaned: 25,
      skipped: 0,
      failed: 0,
    });
    const remaining = await getDb(env)
      .prepare(
        `SELECT COUNT(*) AS count FROM provider_credentials
         WHERE secret_retention_expires_at IS NOT NULL`
      )
      .first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });

  it("does not let 25 persistently failing rows starve later cleanup", async () => {
    destroyVersion.mockRejectedValue(new Error("persistent GCP failure"));
    for (let index = 0; index < 25; index += 1) {
      const id = `pcred_failure_${index.toString().padStart(2, "0")}`;
      await insertCredential({
        id,
        backend: "gcp_secret_manager",
        retentionExpiresAt: "2020-01-01T00:00:00.000Z",
      });
      await getDb(env)
        .prepare(
          "UPDATE provider_credentials SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?"
        )
        .bind(id)
        .run();
    }
    await insertCredential({
      id: "pcred_later_encrypted",
      retentionExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    await getDb(env)
      .prepare(
        "UPDATE provider_credentials SET updated_at = '2020-01-02T00:00:00.000Z' WHERE id = ?"
      )
      .bind("pcred_later_encrypted")
      .run();

    await expect(cleanupRetiredProviderCredentialSecrets(env)).rejects.toThrow(
      "failed for 25 row(s)"
    );
    expect((await credentialState("pcred_later_encrypted")).secret_retention_expires_at).toBeNull();
    await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toMatchObject({
      cleaned: 0,
      failed: 0,
    });

    expect((await credentialState("pcred_later_encrypted")).secret_retention_expires_at).toBeNull();
  });
});
