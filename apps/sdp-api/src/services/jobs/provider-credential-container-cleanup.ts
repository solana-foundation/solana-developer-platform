import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import type { CredentialSecretStore } from "@/services/credential-secret-store";
import {
  type CredentialSecretContainerRow,
  ProviderCredentialSecretCleanupStore,
  type RetainedProviderCredentialSecretRow,
} from "@/services/stores/provider-credential-secret-cleanup.store";
import type { Env } from "@/types/env";

export interface GcpContainerScanResult {
  scanned: string[];
  failed: string[];
  cleaned: number;
  skipped: number;
  deferred?: number;
  deadlineReached?: true;
}

// Inventory validates the GCP project; references within its container may
// spell that project as either its ID or number.
function relativeVersionRef(ref: string): string {
  return ref.replace(/^projects\/[^/]+\//, "");
}

/** One retained owner schedules a container; cancelled attempts never close its inventory. */
export async function scanGcpCredentialContainers(
  env: Env,
  createSecrets: () => CredentialSecretStore,
  options: { now?: Date; limit?: number; deadlineMs?: number } = {}
): Promise<GcpContainerScanResult> {
  const deadlineMs = options.deadlineMs ?? performance.now() + 100_000;
  if (!Number.isFinite(deadlineMs)) throw new Error("Cleanup deadline must be finite");
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadlineMs - performance.now())));
  const store = new ProviderCredentialSecretCleanupStore(getDb(env));
  const result: GcpContainerScanResult = { scanned: [], failed: [], cleaned: 0, skipped: 0 };
  const failed = new Set<string>();
  let secrets: CredentialSecretStore | undefined;
  function resolveSecrets(): CredentialSecretStore {
    secrets ??= createSecrets();
    return secrets;
  }
  function assertContainerOwnership(
    owner: CredentialSecretContainerRow,
    rows: RetainedProviderCredentialSecretRow[]
  ): void {
    if (
      rows.some(
        (row) =>
          row.organization_id !== owner.organization_id ||
          row.provider !== "privy" ||
          row.storage_backend !== "gcp_secret_manager"
      )
    ) {
      throw new Error("Managed container has inconsistent Credential ownership");
    }
  }
  const expired = () => performance.now() >= deadlineMs || signal.aborted;
  function checkDeadline(): void {
    if (expired()) throw new DOMException("Cleanup deadline reached", "TimeoutError");
  }
  function failure(owner: CredentialSecretContainerRow, error: unknown, versionRef?: string): void {
    failed.add(owner.secret_ref);
    getLogger().error(
      {
        organizationId: owner.organization_id,
        containerOwnerCredentialId: owner.id,
        secretRef: owner.secret_ref,
        secretVersionRef: versionRef,
        provider: "privy",
        storageBackend: "gcp_secret_manager",
        reason: "secret_cleanup_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      },
      "provider_credential_orphan_risk"
    );
  }
  async function destroyVersion(
    owner: CredentialSecretContainerRow,
    versionRef: string,
    credentialId?: string
  ): Promise<void> {
    try {
      await resolveSecrets().destroyVersion({
        secretVersionRef: versionRef,
        signal,
        requireDestroyed: true,
      });
    } catch (error) {
      if (expired()) {
        getLogger().warn(
          {
            organizationId: owner.organization_id,
            containerOwnerCredentialId: owner.id,
            providerCredentialId: credentialId,
            secretRef: owner.secret_ref,
            secretVersionRef: versionRef,
            outcome: "destruction_unconfirmed",
            reason: "cleanup_deadline_reached",
          },
          "provider_credential_secret_destruction_unconfirmed"
        );
      }
      throw error;
    }
    getLogger().info(
      {
        organizationId: owner.organization_id,
        containerOwnerCredentialId: owner.id,
        providerCredentialId: credentialId,
        secretRef: owner.secret_ref,
        secretVersionRef: versionRef,
        outcome: "confirmed_destroyed",
        kind: credentialId ? "retained_version" : "unreferenced_version",
      },
      "provider_credential_secret_destroyed"
    );
  }
  async function destroyKnown(
    owner: CredentialSecretContainerRow,
    row: RetainedProviderCredentialSecretRow
  ): Promise<void> {
    if (!row.secret_version_ref) return;
    checkDeadline();
    const candidate = await store.fenceGcpCleanupCandidate({
      id: row.id,
      expectedSecretVersionRef: row.secret_version_ref,
    });
    checkDeadline();
    if (!candidate) {
      result.skipped += 1;
      return;
    }
    // Record acknowledged destruction even if there is no time left to clear its marker.
    await destroyVersion(owner, row.secret_version_ref, row.id);
    checkDeadline();
    const cleared = await store.clearGcpRetentionMarker({
      id: candidate.id,
      expectedSecretVersionRef: row.secret_version_ref,
      expectedRetentionExpiresAt: candidate.secret_retention_expires_at,
    });
    result[cleared ? "cleaned" : "skipped"] += 1;
    checkDeadline();
  }
  async function cleanupPending(
    owner: CredentialSecretContainerRow,
    handled: Set<string>
  ): Promise<void> {
    // Exact retained refs remain retryable even when list omits an already-destroyed version.
    const pending = await store.listPendingDestructions(owner, 25);
    checkDeadline();
    for (const row of pending) {
      if (!row.secret_version_ref) continue;
      handled.add(row.secret_version_ref);
      try {
        await destroyKnown(owner, row);
      } catch (error) {
        if (expired()) throw error;
        failure(owner, error, row.secret_version_ref);
      }
    }
  }

  async function cleanupListedVersion(
    owner: CredentialSecretContainerRow,
    versionRef: string,
    credentials: RetainedProviderCredentialSecretRow[]
  ): Promise<void> {
    const references = credentials.filter(
      (row) =>
        row.secret_version_ref !== null &&
        relativeVersionRef(row.secret_version_ref) === relativeVersionRef(versionRef)
    );
    if (references.length > 1) throw new Error("GCP version has multiple Credential owners");
    if (references[0]) return destroyKnown(owner, references[0]);
    if (credentials.some((row) => row.status === "creating")) {
      result.skipped += 1;
      return;
    }
    // Only SDP writes this namespace; a later writer creates a new version outside
    // this page, and cancelled writers cannot adopt a version from it.
    await destroyVersion(owner, versionRef);
    result.cleaned += 1;
  }

  async function scan(owner: CredentialSecretContainerRow): Promise<void> {
    await store.cancelStaleCreations(owner);
    checkDeadline();
    assertContainerOwnership(owner, await store.listContainerCredentials(owner.secret_ref));
    checkDeadline();
    const secretStore = resolveSecrets();
    const listVersions = secretStore.listVersions?.bind(secretStore);
    if (!listVersions) throw new Error("Managed version inventory is unavailable");
    const handled = new Set<string>();
    await cleanupPending(owner, handled);

    const pageTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      checkDeadline();
      const page = await listVersions({
        secretRef: owner.secret_ref,
        pageToken,
        signal,
        liveOnly: true,
      });
      checkDeadline();
      // Each page's decisions use a fresh primary-DB snapshot AFTER that page.
      const credentials = await store.listContainerCredentials(owner.secret_ref);
      checkDeadline();
      assertContainerOwnership(owner, credentials);
      for (const version of page.versions) {
        checkDeadline();
        if (version.state === "DESTROYED" || handled.has(version.secretVersionRef)) continue;
        handled.add(version.secretVersionRef);
        try {
          await cleanupListedVersion(owner, version.secretVersionRef, credentials);
        } catch (error) {
          if (expired()) throw error;
          failure(owner, error, version.secretVersionRef);
        }
      }
      if (page.nextPageToken && pageTokens.has(page.nextPageToken))
        throw new Error("Repeated GCP inventory page token");
      pageToken = page.nextPageToken;
      if (pageToken) pageTokens.add(pageToken);
      // Live-only listing means destroyed history cannot monopolize every later
      // bounded pass. Pagination changes may omit a version this pass, never close it.
    } while (pageToken);
  }

  if (expired()) return { ...result, deadlineReached: true, deferred: 0 };
  const now = options.now ?? new Date();
  let owners: CredentialSecretContainerRow[];
  try {
    owners = await store.listDueContainers(now, Math.min(options.limit ?? 25, 25));
  } catch (error) {
    if (expired()) return { ...result, deadlineReached: true, deferred: 0 };
    throw error;
  }
  if (expired()) return { ...result, deadlineReached: true, deferred: owners.length };
  for (const [index, owner] of owners.entries()) {
    try {
      checkDeadline();
      // Fixed revisit time, not a lease: no completion write can clobber a later scan.
      if (!(await store.advanceContainerScan(owner, now))) continue;
      checkDeadline();
      await scan(owner);
      result.scanned.push(owner.secret_ref);
    } catch (error) {
      if (expired()) {
        result.deadlineReached = true;
        result.deferred = owners.length - index;
        getLogger().warn(
          {
            organizationId: owner.organization_id,
            containerOwnerCredentialId: owner.id,
            provider: "privy",
            storageBackend: "gcp_secret_manager",
            reason: "cleanup_deadline_reached",
            outcome: "scan_incomplete",
          },
          "provider_credential_cleanup_interrupted"
        );
        break;
      }
      failure(owner, error);
    }
  }
  result.failed = [...failed];
  return result;
}
