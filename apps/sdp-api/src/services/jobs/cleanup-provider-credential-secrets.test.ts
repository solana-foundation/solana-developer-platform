import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { rootLogger } from "@/runtime/logger";
import type { CredentialSecretStore } from "@/services/credential-secret-store";
import { ProviderCredentialStore } from "@/services/stores/provider-credential.store";
import { ProviderCredentialSecretCleanupStore } from "@/services/stores/provider-credential-secret-cleanup.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { cleanupRetiredProviderCredentialSecrets } from "./cleanup-provider-credential-secrets";

const createCredentialSecretStore = vi.hoisted(() => vi.fn());
const destroyVersion = vi.hoisted(() => vi.fn());

vi.mock("@/services/credential-secret-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/credential-secret-store")>()),
  createCredentialSecretStore,
}));

const ORGANIZATION_ID = "org_credential_cleanup";
const PROJECT_ID = "prj_credential_cleanup";
const USER_ID = "usr_credential_cleanup";

async function insertCredential(params: {
  id: string;
  status?: "pending" | "active" | "failed_validation" | "retired" | "deactivated";
  backend?: "encrypted_db" | "gcp_secret_manager";
  retentionExpiresAt?: string | null;
  rotatedFromId?: string | null;
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
         deactivated_at, created_by
       ) VALUES (
         ?, ?, 'privy', 'Privy', 'organization', 'stored', ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`
    )
    .bind(
      params.id,
      ORGANIZATION_ID,
      backend,
      gcp ? `projects/p/secrets/sdp-provider-credentials-${params.id}` : null,
      gcp ? `projects/p/secrets/sdp-provider-credentials-${params.id}/versions/7` : null,
      gcp ? null : "v2.ciphertext",
      status,
      params.rotatedFromId ?? null,
      params.retentionExpiresAt ?? null,
      status === "deactivated" ? "2026-09-04T10:00:00.000Z" : null,
      USER_ID
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
    createCredentialSecretStore.mockReturnValue({
      storageBackend: "gcp_secret_manager",
      write: vi.fn(),
      read: vi.fn(),
      destroyVersion: destroyVersion.mockResolvedValue(undefined),
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
    });
    expect((await credentialState("pcred_expired_gcp")).secret_retention_expires_at).toBeNull();
  });

  it("lets an in-flight rollback win before destroying the predecessor secret", async () => {
    const predecessorId = "pcred_rollback_wins";
    const currentId = "pcred_rollback_wins_current";
    const connectionId = "conn_rollback_wins";
    const retentionExpiresAt = new Date(Date.now() + 1_500).toISOString();
    await insertCredential({
      id: predecessorId,
      backend: "gcp_secret_manager",
      retentionExpiresAt,
    });
    await insertCredential({ id: currentId, status: "active", rotatedFromId: predecessorId });
    await insertConnection(connectionId, currentId);

    let releaseRollback: (() => void) | undefined;
    let markRollbackReady: (() => void) | undefined;
    const rollbackGate = new Promise<void>((resolve) => {
      releaseRollback = resolve;
    });
    const rollbackReady = new Promise<void>((resolve) => {
      markRollbackReady = resolve;
    });
    const rollback = getDb(env).transaction(async (tx) => {
      const changed = await new ProviderCredentialStore(tx).rollBackCredential({
        organizationId: ORGANIZATION_ID,
        currentId,
        predecessorId,
        predecessorScopeKey: "__organization__",
        expectedConnectionIds: [connectionId],
      });
      expect(changed).toBe(true);
      markRollbackReady?.();
      await rollbackGate;
    });
    await rollbackReady;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, Date.parse(retentionExpiresAt) - Date.now() + 50));
    });

    const cleanupStore = new ProviderCredentialSecretCleanupStore(getDb(env));
    await expect(cleanupStore.listDue(25)).resolves.toEqual([
      expect.objectContaining({ id: predecessorId }),
    ]);
    const fenced = cleanupStore.fenceGcpCleanupCandidate({
      id: predecessorId,
      expectedRetentionExpiresAt: retentionExpiresAt,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(destroyVersion).not.toHaveBeenCalled();

    releaseRollback?.();
    await rollback;
    await expect(fenced).resolves.toBeNull();
    expect(destroyVersion).not.toHaveBeenCalled();
    await expect(credentialState(predecessorId)).resolves.toMatchObject({
      status: "active",
      secret_retention_expires_at: null,
    });
  });

  it("makes rollback ineligible after cleanup wins", async () => {
    const predecessorId = "pcred_cleanup_wins";
    const currentId = "pcred_cleanup_wins_current";
    const connectionId = "conn_cleanup_wins";
    await insertCredential({
      id: predecessorId,
      backend: "gcp_secret_manager",
      retentionExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    await insertCredential({ id: currentId, status: "active", rotatedFromId: predecessorId });
    await insertConnection(connectionId, currentId);

    await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toEqual({
      cleaned: 1,
      skipped: 0,
      failed: 0,
    });
    await expect(
      getDb(env).transaction(async (tx) => {
        const changed = await new ProviderCredentialStore(tx).rollBackCredential({
          organizationId: ORGANIZATION_ID,
          currentId,
          predecessorId,
          predecessorScopeKey: "__organization__",
          expectedConnectionIds: [connectionId],
        });
        if (!changed) throw new Error("Rollback is no longer eligible");
      })
    ).rejects.toThrow("Rollback is no longer eligible");
    expect(destroyVersion).toHaveBeenCalledOnce();
    expect(
      await getDb(env).queryOne<{ provider_credential_id: string }>(
        "SELECT provider_credential_id FROM custody_connections WHERE id = ?",
        [connectionId]
      )
    ).toEqual({ provider_credential_id: currentId });
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
      {
        providerCredentialId: "pcred_a_failure",
        provider: "privy",
        storageBackend: "gcp_secret_manager",
        providerResourceVersion: 7,
        reason: "secret_cleanup_failed",
      },
      "provider_credential_orphan_risk"
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain(rawFailure);
    expect(JSON.stringify(logError.mock.calls)).not.toContain("projects/p/secrets");
  });

  it.each(["failed_validation", "deactivated"] as const)(
    "retries cleanup for a GCP rotation candidate that ends %s without changing its status",
    async (status) => {
      const predecessorId = `pcred_${status}_predecessor`;
      const candidateId = `pcred_${status}_candidate`;
      await insertCredential({ id: predecessorId, status: "active" });
      await insertCredential({
        id: candidateId,
        status: "pending",
        backend: "gcp_secret_manager",
        rotatedFromId: predecessorId,
      });
      const credentialStore = new ProviderCredentialStore(getDb(env));
      const transitioned =
        status === "failed_validation"
          ? await credentialStore.recordRotationFailure(candidateId, "invalid_credentials")
          : await credentialStore.deactivateRotationCandidate({
              organizationId: ORGANIZATION_ID,
              candidateId,
              predecessorId,
            });
      expect(transitioned).toBe(true);
      const retentionExpiresAt = (await credentialState(candidateId)).secret_retention_expires_at;
      expect(retentionExpiresAt).toEqual(expect.any(String));
      destroyVersion.mockRejectedValueOnce(new Error("transient GCP failure"));

      await expect(cleanupRetiredProviderCredentialSecrets(env)).rejects.toThrow(
        "Provider Credential secret cleanup failed for 1 row(s)"
      );
      await expect(credentialState(candidateId)).resolves.toMatchObject({
        status,
        secret_retention_expires_at: retentionExpiresAt,
      });

      await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toEqual({
        cleaned: 1,
        skipped: 0,
        failed: 0,
      });
      expect(destroyVersion).toHaveBeenCalledTimes(2);
      expect(destroyVersion).toHaveBeenLastCalledWith({
        secretVersionRef: `projects/p/secrets/sdp-provider-credentials-${candidateId}/versions/7`,
      });
      await expect(credentialState(candidateId)).resolves.toMatchObject({
        status,
        secret_retention_expires_at: null,
      });
    }
  );

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
    await expect(cleanupRetiredProviderCredentialSecrets(env)).rejects.toThrow();

    expect((await credentialState("pcred_later_encrypted")).secret_retention_expires_at).toBeNull();
  });
});
