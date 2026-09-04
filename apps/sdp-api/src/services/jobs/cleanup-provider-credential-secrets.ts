import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import {
  type CredentialSecretStore,
  createCredentialSecretStore,
} from "@/services/credential-secret-store";
import {
  ProviderCredentialSecretCleanupStore,
  type RetainedProviderCredentialSecretRow,
} from "@/services/stores/provider-credential-secret-cleanup.store";
import type { Env } from "@/types/env";

const BATCH_SIZE = 25;

export interface CleanupProviderCredentialSecretsResult {
  cleaned: number;
  skipped: number;
  failed: number;
}

function resourceVersion(secretVersionRef: string | null): number | undefined {
  const version = secretVersionRef?.split("/").at(-1);
  return version && /^[1-9][0-9]*$/.test(version) ? Number(version) : undefined;
}

function logCleanupFailure(row: RetainedProviderCredentialSecretRow): void {
  getLogger().error(
    {
      providerCredentialId: row.id,
      provider: row.provider,
      storageBackend: row.storage_backend,
      providerResourceVersion: resourceVersion(row.secret_version_ref) ?? null,
      reason: "secret_cleanup_failed",
    },
    "provider_credential_orphan_risk"
  );
}

export async function cleanupRetiredProviderCredentialSecrets(
  env: Env
): Promise<CleanupProviderCredentialSecretsResult> {
  const store = new ProviderCredentialSecretCleanupStore(getDb(env));
  const due = await store.listDue(BATCH_SIZE);
  const result: CleanupProviderCredentialSecretsResult = { cleaned: 0, skipped: 0, failed: 0 };
  let gcpStore: CredentialSecretStore | undefined;

  for (const row of due) {
    try {
      if (row.storage_backend === "encrypted_db") {
        const cleaned = await store.cleanupEncryptedDb({
          id: row.id,
          expectedRetentionExpiresAt: row.secret_retention_expires_at,
        });
        result[cleaned ? "cleaned" : "skipped"] += 1;
        continue;
      }

      // The conditional write serializes this irreversible destroy against a
      // last-moment rollback, then commits before the Provider call.
      const candidate = await store.fenceGcpCleanupCandidate({
        id: row.id,
        expectedRetentionExpiresAt: row.secret_retention_expires_at,
      });
      if (!candidate) {
        result.skipped += 1;
        continue;
      }
      if (!candidate.secret_version_ref) {
        throw new Error("Provider Credential is missing its managed secret version");
      }

      gcpStore ??= createCredentialSecretStore(env, "gcp_secret_manager");
      await gcpStore.destroyVersion({ secretVersionRef: candidate.secret_version_ref });
      const cleaned = await store.clearGcpRetentionMarker({
        id: candidate.id,
        expectedRetentionExpiresAt: candidate.secret_retention_expires_at,
        expectedSecretVersionRef: candidate.secret_version_ref,
      });
      result[cleaned ? "cleaned" : "skipped"] += 1;
    } catch {
      result.failed += 1;
      logCleanupFailure(row);
    }
  }

  if (result.failed > 0) {
    throw new Error(`Provider Credential secret cleanup failed for ${result.failed} row(s)`);
  }
  return result;
}
