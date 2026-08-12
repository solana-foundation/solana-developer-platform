/**
 * What happens to a secret version whose destroy call fails.
 *
 * Retiring a workflow action's signing secret runs after the rotation or delete it
 * follows has committed, so it cannot fail the request. That used to mean a backend
 * failure was only logged: the superseded credential stayed readable in Secret Manager
 * with nothing pointing at it and nothing that would ever try again. These tests pin the
 * two halves of the fix — the failure becomes durable work, and the sweeper drains it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  CredentialSecretStoreError,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import { destroyActionSecret } from "@/services/workflows/action-secret";
import { env } from "@/test/helpers/env";
import { retireOrphanedActionSecrets } from "./retire-workflow-secrets";

const secretStore = vi.hoisted(() => ({
  storageBackend: "gcp_secret_manager" as const,
  write: vi.fn(),
  read: vi.fn(),
  destroyVersion: vi.fn(),
}));
const createCredentialSecretStore = vi.hoisted(() => vi.fn());

vi.mock("@/services/credential-secret-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/credential-secret-store")>()),
  createCredentialSecretStore,
}));

// How many times the queue insert rejects before it is allowed through, standing in for
// the transient Postgres errors the driver propagates (dropped connection, deadlock,
// statement timeout). Everything else delegates to the real repository.
const queueInsertFailures = vi.hoisted(() => ({ remaining: 0 }));

vi.mock("@/db/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/repositories")>();
  return {
    ...actual,
    createWorkflowSecretRetirementsRepository: (
      env: Parameters<typeof actual.createWorkflowSecretRetirementsRepository>[0]
    ) => {
      const repo = actual.createWorkflowSecretRetirementsRepository(env);
      return {
        ...repo,
        recordRetirement(input: Parameters<typeof repo.recordRetirement>[0]) {
          if (queueInsertFailures.remaining > 0) {
            queueInsertFailures.remaining -= 1;
            return Promise.reject(new Error("Connection terminated unexpectedly"));
          }
          return repo.recordRetirement(input);
        },
      };
    },
  };
});

const VERSION_REF = "projects/p/secrets/sdp-workflow-action-1/versions/3";

function storedSecret(versionRef = VERSION_REF): StoredCredentialSecret {
  return {
    storageBackend: "gcp_secret_manager",
    secretRef: "projects/p/secrets/sdp-workflow-action-1",
    secretVersionRef: versionRef,
  } as StoredCredentialSecret;
}

async function queuedRetirements() {
  const result = await getDb(env)
    .prepare(
      `SELECT secret_version_ref, workflow_id, attempt_count, last_error, next_attempt_at
         FROM workflow_action_secret_retirements ORDER BY created_at ASC`
    )
    .all<{
      secret_version_ref: string;
      workflow_id: string | null;
      attempt_count: number;
      last_error: string | null;
      next_attempt_at: string;
    }>();
  return result.results;
}

describe("orphaned workflow secret retirement", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    createCredentialSecretStore.mockReturnValue(secretStore);
    secretStore.destroyVersion.mockResolvedValue(undefined);
    queueInsertFailures.remaining = 0;
    await getDb(env).prepare("DELETE FROM workflow_action_secret_retirements").run();
  });

  // The reported bug: the backend refuses and the request moves on, leaving the version
  // alive with nothing recording that it still needs destroying.
  it("records durable work when the backend refuses the destroy", async () => {
    secretStore.destroyVersion.mockRejectedValue(new Error("permission denied"));

    await destroyActionSecret(env, storedSecret(), {
      orgId: "org_1",
      workflowId: "asset_workflow_1",
    });

    const queued = await queuedRetirements();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.secret_version_ref).toBe(VERSION_REF);
    // Traceable back to the rule it came from, and carrying why it failed.
    expect(queued[0]?.workflow_id).toBe("asset_workflow_1");
    expect(queued[0]?.last_error).toContain("permission denied");
  });

  // The queue row is the ONLY thing the sweeper reads, so losing the insert loses the
  // orphan entirely. A single attempt used to be the whole budget: one dropped connection
  // between the failed destroy and the insert and the version stayed readable in the
  // backend forever, with nothing that would ever try again.
  it("still queues the orphan when the insert fails transiently", async () => {
    secretStore.destroyVersion.mockRejectedValue(new Error("permission denied"));
    queueInsertFailures.remaining = 2;

    await destroyActionSecret(env, storedSecret(), { orgId: "org_1", workflowId: "wf_1" });

    const queued = await queuedRetirements();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.secret_version_ref).toBe(VERSION_REF);
    expect(queued[0]?.last_error).toContain("permission denied");
  });

  // The honest boundary: retries narrow the window, they do not close it. A database that
  // stays unreachable leaves the log as the only record — and retirement still must not
  // fail the request that already committed.
  it("does not throw when the insert cannot be made to stick at all", async () => {
    secretStore.destroyVersion.mockRejectedValue(new Error("permission denied"));
    queueInsertFailures.remaining = 10;

    await expect(
      destroyActionSecret(env, storedSecret(), { orgId: "org_1", workflowId: "wf_1" })
    ).resolves.toBeUndefined();
    expect(await queuedRetirements()).toHaveLength(0);
  });

  it("queues nothing when the destroy succeeds", async () => {
    await destroyActionSecret(env, storedSecret(), { orgId: "org_1", workflowId: "wf_1" });

    expect(secretStore.destroyVersion).toHaveBeenCalledTimes(1);
    expect(await queuedRetirements()).toHaveLength(0);
  });

  // The other half: queued work is worthless unless something drains it.
  it("destroys the queued version on a later sweep and clears the row", async () => {
    secretStore.destroyVersion.mockRejectedValueOnce(new Error("upstream unavailable"));
    await destroyActionSecret(env, storedSecret(), { orgId: "org_1", workflowId: "wf_1" });
    expect(await queuedRetirements()).toHaveLength(1);

    // The backend recovers.
    secretStore.destroyVersion.mockResolvedValue(undefined);
    const result = await retireOrphanedActionSecrets(env);

    expect(result).toEqual({ retired: 1, failed: 0 });
    expect(secretStore.destroyVersion).toHaveBeenLastCalledWith({ secretVersionRef: VERSION_REF });
    expect(await queuedRetirements()).toHaveLength(0);
  });

  // A still-failing destroy must stay queued — abandoning it is the original bug.
  // A queued row is due immediately, so the sweep time has to be at or after insertion
  // for it to be picked up at all; a fixed date in the past would silently sweep nothing.
  it("keeps the row and backs off when the sweep fails again", async () => {
    secretStore.destroyVersion.mockRejectedValue(new Error("permission denied"));
    await destroyActionSecret(env, storedSecret(), { orgId: "org_1", workflowId: "wf_1" });

    const sweptAt = new Date(Date.now() + 1_000);
    const result = await retireOrphanedActionSecrets(env, sweptAt);

    expect(result).toEqual({ retired: 0, failed: 1 });
    const queued = await queuedRetirements();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.attempt_count).toBe(1);
    expect(new Date(queued[0]?.next_attempt_at ?? 0).getTime()).toBeGreaterThan(sweptAt.getTime());
  });

  // Backoff has to actually hold the row back, or the sweep is a busy loop.
  it("leaves a not-yet-due row alone", async () => {
    secretStore.destroyVersion.mockRejectedValue(new Error("permission denied"));
    await destroyActionSecret(env, storedSecret(), { orgId: "org_1", workflowId: "wf_1" });
    const firstSweep = new Date(Date.now() + 1_000);
    expect(await retireOrphanedActionSecrets(env, firstSweep)).toEqual({ retired: 0, failed: 1 });
    vi.clearAllMocks();
    createCredentialSecretStore.mockReturnValue(secretStore);

    // One minute later — well inside the 10-minute backoff the failed attempt set.
    const tooSoon = new Date(firstSweep.getTime() + 60_000);
    const result = await retireOrphanedActionSecrets(env, tooSoon);

    expect(result).toEqual({ retired: 0, failed: 0 });
    expect(secretStore.destroyVersion).not.toHaveBeenCalled();
    expect(await queuedRetirements()).toHaveLength(1);
  });

  // Reporting the same orphan twice must not queue it twice.
  it("does not duplicate a version already queued", async () => {
    secretStore.destroyVersion.mockRejectedValue(new Error("permission denied"));

    await destroyActionSecret(env, storedSecret(), { orgId: "org_1", workflowId: "wf_1" });
    await destroyActionSecret(env, storedSecret(), { orgId: "org_1", workflowId: "wf_1" });

    expect(await queuedRetirements()).toHaveLength(1);
  });

  // A queued row names the backend its version actually lives in. The sweeper built one
  // store from the deployment's CURRENT backend and used it for every row, so migrating
  // (gcp_secret_manager → encrypted_db) handed every queued GCP version to a store with
  // no external versions at all: UNSUPPORTED_OPERATION on every sweep, backed off and
  // retried forever, with the credential still readable in Secret Manager.
  it("destroys through the backend the row names, not the deployment's current one", async () => {
    // Queued while GCP is still the active backend.
    secretStore.destroyVersion.mockRejectedValueOnce(new Error("upstream unavailable"));
    await destroyActionSecret(env, storedSecret(), { orgId: "org_1", workflowId: "wf_1" });
    expect(await queuedRetirements()).toHaveLength(1);

    // The deployment migrates. `encrypted_db` keeps its ciphertext inline, so it has no
    // version to destroy and refuses outright.
    const encryptedDbStore = {
      storageBackend: "encrypted_db" as const,
      write: vi.fn(),
      read: vi.fn(),
      destroyVersion: vi
        .fn()
        .mockRejectedValue(
          new CredentialSecretStoreError("no external versions", "UNSUPPORTED_OPERATION")
        ),
    };
    secretStore.destroyVersion.mockResolvedValue(undefined);
    createCredentialSecretStore.mockImplementation((_env: unknown, backend?: string) =>
      backend === "gcp_secret_manager" ? secretStore : encryptedDbStore
    );

    const result = await retireOrphanedActionSecrets(env, new Date(Date.now() + 1_000));

    expect(result).toEqual({ retired: 1, failed: 0 });
    expect(secretStore.destroyVersion).toHaveBeenLastCalledWith({ secretVersionRef: VERSION_REF });
    expect(encryptedDbStore.destroyVersion).not.toHaveBeenCalled();
    expect(await queuedRetirements()).toHaveLength(0);
  });

  // Backends that store the ciphertext inline have no external version to destroy; it
  // goes away with the row, so there is nothing to queue.
  it("ignores a non-GCP backend", async () => {
    await destroyActionSecret(
      env,
      {
        storageBackend: "encrypted_db",
        secretVersionRef: null,
      } as unknown as StoredCredentialSecret,
      { orgId: "org_1", workflowId: "wf_1" }
    );

    expect(secretStore.destroyVersion).not.toHaveBeenCalled();
    expect(await queuedRetirements()).toHaveLength(0);
  });
});
