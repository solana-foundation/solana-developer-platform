import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import { createCredentialSecretStore } from "@/services/credential-secret-store";
import { ProviderCredentialSecretCleanupStore } from "@/services/stores/provider-credential-secret-cleanup.store";
import type { Env } from "@/types/env";
import { scanGcpCredentialContainers } from "./provider-credential-container-cleanup";

export interface CleanupProviderCredentialSecretsResult {
  cleaned: number;
  skipped: number;
  failed: number;
  deferred?: number;
  deadlineReached?: true;
}

export async function cleanupRetiredProviderCredentialSecrets(
  env: Env,
  options: { deadlineMs?: number } = {}
): Promise<CleanupProviderCredentialSecretsResult> {
  const deadlineMs = options.deadlineMs ?? performance.now() + 100_000;
  if (!Number.isFinite(deadlineMs)) throw new Error("Cleanup deadline must be finite");
  const result: CleanupProviderCredentialSecretsResult = { cleaned: 0, skipped: 0, failed: 0 };
  // ponytail: SQL waits retain the existing client behavior; admission and HTTP,
  // not an outstanding SQL wait, are bounded by this deadline.
  const store = new ProviderCredentialSecretCleanupStore(getDb(env));
  if (performance.now() < deadlineMs) {
    const rows = await store.listDueEncrypted(25);
    for (const row of rows) {
      if (performance.now() >= deadlineMs) break;
      try {
        const cleaned =
          row.secret_retention_expires_at &&
          (await store.cleanupEncryptedDb({
            id: row.id,
            expectedRetentionExpiresAt: row.secret_retention_expires_at,
          }));
        result[cleaned ? "cleaned" : "skipped"] += 1;
      } catch {
        result.failed += 1;
        getLogger().error(
          { providerCredentialId: row.id, reason: "secret_cleanup_failed" },
          "provider_credential_orphan_risk"
        );
      }
    }
  }
  const scanned = await scanGcpCredentialContainers(
    env,
    () => createCredentialSecretStore(env, "gcp_secret_manager"),
    { deadlineMs }
  );
  result.cleaned += scanned.cleaned;
  result.skipped += scanned.skipped;
  result.failed += scanned.failed.length;
  if (scanned.deadlineReached) {
    result.deadlineReached = true;
    result.deferred = scanned.deferred;
    getLogger().info({ ...result }, "provider_credential_cleanup_deferred");
  }
  if (result.failed > 0)
    throw new Error(`Provider Credential secret cleanup failed for ${result.failed} row(s)`);
  return result;
}
