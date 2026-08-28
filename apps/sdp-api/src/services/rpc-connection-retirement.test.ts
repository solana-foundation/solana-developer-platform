// Durable retirement of BYOK RPC credential secret versions.
//
// The create path writes the tenant's key to the secret store BEFORE the rows
// that reference it, and deactivation is terminal — so both ends of the
// lifecycle can orphan a GCP secret version. These tests prove the orphan can
// no longer be lost: the obligation is queued before the referencing write,
// cancelled by the commit, refreshed by a failed destroy, and drained by the
// existing retirement sweeper (cleanup recovery).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import { retireOrphanedActionSecrets } from "@/services/jobs/retire-workflow-secrets";
import { deactivateRpcConnection, submitRpcConnection } from "@/services/rpc-connection.service";
import { queuePendingSecretVersion } from "@/services/secret-retirement";
import { ProviderCredentialStore } from "@/services/stores/provider-credential.store";
import { RpcConnectionStore } from "@/services/stores/rpc-connection.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

const gcpMock = vi.hoisted(() => ({
  destroyVersion: vi.fn<(input: { secretVersionRef: string }) => Promise<void>>(),
}));

const retirementQueueControl = vi.hoisted(() => ({ failRecordRetirement: false }));

// The durable queue is a real table in these tests; this wrapper only exists
// so one test can make the obligation insert fail and prove the create fails
// closed instead of proceeding into the unprotected window.
vi.mock("@/db/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/repositories")>();
  return {
    ...actual,
    createWorkflowSecretRetirementsRepository: (
      ...args: Parameters<typeof actual.createWorkflowSecretRetirementsRepository>
    ) => {
      const repository = actual.createWorkflowSecretRetirementsRepository(...args);
      return {
        ...repository,
        recordRetirement: async (input: Parameters<typeof repository.recordRetirement>[0]) => {
          if (retirementQueueControl.failRecordRetirement) {
            throw new Error("retirement queue unavailable");
          }
          return repository.recordRetirement(input);
        },
      };
    },
  };
});

// A stand-in GCP store: the test environment has no Secret Manager, and what
// is under test is the bookkeeping around the destroy, not the destroy itself.
vi.mock("@/services/credential-secret-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/credential-secret-store")>();
  return {
    ...actual,
    createCredentialSecretStore: () => ({
      storageBackend: "gcp_secret_manager" as const,
      write: async (input: { providerCredentialId: string }) => ({
        storageBackend: "gcp_secret_manager" as const,
        secretRef: `projects/sdp-test/secrets/${input.providerCredentialId}`,
        secretVersionRef: `projects/sdp-test/secrets/${input.providerCredentialId}/versions/1`,
      }),
      read: async () => ({}),
      destroyVersion: gcpMock.destroyVersion,
    }),
  };
});

// Saving probes the tenant endpoint before it writes anything (HOO-1228).
// What is under test here is the fate of the secret version around that save,
// so the provider answers healthily for the project's cluster; the probe's own
// behaviour is covered by the `rpc-byok-*` suites.
vi.mock("@/services/rpc-probe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/rpc-probe")>();
  const { SOLANA_GENESIS_HASHES } = await import("@sdp/rpc/byok");
  return {
    ...actual,
    probeRpcEndpoint: async () => ({
      upstream: { ok: true, status: 200 },
      upstreamBody: { result: SOLANA_GENESIS_HASHES.devnet },
    }),
  };
});

const ORG_ID = "org_rpc_retirement";
const USER_ID = "usr_rpc_retirement";
/**
 * A project per saving test. A project holds one connection per provider
 * (HOO-1227) and the check runs before the secret is written, so tests sharing
 * a project would be refused before reaching the code under test.
 */
const PROJECT_COMMITTED = "prj_rpc_retirement_committed";
const PROJECT_UNRECORDABLE = "prj_rpc_retirement_unrecordable";
const PROJECT_DOOMED = "prj_rpc_retirement_doomed";
const PROJECT_LEAKED = "prj_rpc_retirement_leaked";
const PROJECT_DEACTIVATE = "prj_rpc_retirement_deactivate";
const appEnv = env as unknown as Env;

function serviceContext(projectId: string = PROJECT_DEACTIVATE) {
  const values: Record<string, unknown> = {
    clerk: {
      userId: USER_ID,
      organizationId: ORG_ID,
      role: "admin",
      permissions: ["org:read", "org:write", "org:admin"],
    },
    projectId,
  };
  return {
    env: appEnv,
    get: (key: string) => values[key],
  } as unknown as Parameters<typeof submitRpcConnection>[0];
}

function submitInput(label: string) {
  return {
    provider: "helius" as const,
    scope: "project" as const,
    credentialLabel: label,
    endpointUrl: "https://devnet.helius-rpc.com",
    apiKey: "tenant-key-retirement",
  };
}

async function seedProject(projectId: string, slug: string): Promise<void> {
  await getDb(appEnv)
    .prepare(
      `INSERT INTO projects (id, organization_id, name, slug, environment, created_by)
       VALUES (?, ?, 'RPC Retirement', ?, 'sandbox', ?)`
    )
    .bind(projectId, ORG_ID, slug, USER_ID)
    .run();
}

async function retirementRows(refLike: string): Promise<Array<{ secret_version_ref: string }>> {
  return getDb(appEnv).queryMany<{ secret_version_ref: string }>(
    `SELECT secret_version_ref FROM workflow_action_secret_retirements
      WHERE secret_version_ref LIKE ?`,
    [refLike]
  );
}

async function seedGcpConnection(suffix: string): Promise<{
  connectionId: string;
  versionRef: string;
}> {
  const db = getDb(appEnv);
  const credentialId = `pcred_retire_${suffix}`;
  const connectionId = `rconn_retire_${suffix}`;
  const versionRef = `projects/sdp-test/secrets/${credentialId}/versions/1`;
  await db
    .prepare(
      `INSERT INTO provider_credentials (
         id, organization_id, project_id, provider, label, scope, source,
         storage_backend, secret_ref, secret_version_ref, status, created_by
       ) VALUES (?, ?, NULL, 'helius', 'Retirement fixture', 'organization', 'stored',
                 'gcp_secret_manager', ?, ?, 'active', ?)`
    )
    .bind(credentialId, ORG_ID, `projects/sdp-test/secrets/${credentialId}`, versionRef, USER_ID)
    .run();
  await new RpcConnectionStore(db).insertConnection({
    id: connectionId,
    organizationId: ORG_ID,
    projectId: null,
    provider: "helius",
    providerCredentialId: credentialId,
    providerCredentialScopeKey: "__organization__",
    network: "devnet",
    displayMetadata: { endpointHost: "devnet.helius-rpc.com", apiKeySuffix: "1234" },
    createdBy: USER_ID,
  });
  return { connectionId, versionRef };
}

beforeAll(async () => {
  await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  const db = getDb(appEnv);
  await db
    .prepare(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, 'RPC Retirement', 'rpc-retirement', 'enterprise', 'active')`
    )
    .bind(ORG_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, 'rpc-retirement@example.com', 1, 'active')`
    )
    .bind(USER_ID)
    .run();
  await seedProject(PROJECT_COMMITTED, "rpc-retirement-committed");
  await seedProject(PROJECT_UNRECORDABLE, "rpc-retirement-unrecordable");
  await seedProject(PROJECT_DOOMED, "rpc-retirement-doomed");
  await seedProject(PROJECT_LEAKED, "rpc-retirement-leaked");
  await seedProject(PROJECT_DEACTIVATE, "rpc-retirement-deactivate");
});

afterAll(async () => {
  await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
});

beforeEach(async () => {
  retirementQueueControl.failRecordRetirement = false;
  gcpMock.destroyVersion.mockReset();
  gcpMock.destroyVersion.mockResolvedValue(undefined);
  await getDb(appEnv).execute(
    `DELETE FROM workflow_action_secret_retirements WHERE secret_version_ref LIKE ?`,
    ["projects/sdp-test/secrets/pcred_%"]
  );
});

describe("BYOK RPC secret retirement", () => {
  it("clears the pre-commit obligation when submission commits", async () => {
    const connection = await submitRpcConnection(
      serviceContext(PROJECT_COMMITTED),
      submitInput("Committed")
    );

    // Saving proves the key and puts it straight into service (HOO-1228).
    expect(connection.status).toBe("active");
    // The rows reference the version, so nothing may destroy it — the
    // provisional obligation must have been cancelled by the same commit.
    expect(await retirementRows("projects/sdp-test/secrets/pcred_%")).toEqual([]);
    expect(gcpMock.destroyVersion).not.toHaveBeenCalled();
  });

  it("withholds a provisional obligation from the sweeper while the create is in flight", async () => {
    // The provisional row is committed BEFORE the transaction that references
    // its version, so for a moment the queue names a version that is about to
    // go live. A sweep landing in that window must not act on it: destroying
    // it would leave the committing transaction pointing at nothing, and the
    // tenant's connection installed dead.
    const stored = {
      storageBackend: "gcp_secret_manager" as const,
      secretRef: "projects/sdp-test/secrets/pcred_inflight",
      secretVersionRef: "projects/sdp-test/secrets/pcred_inflight/versions/1",
    };

    await queuePendingSecretVersion(appEnv, stored, {
      provider: "rpc_connection",
      orgId: ORG_ID,
      sourceId: "pcred_inflight",
    });

    // On record, so worker loss still cannot lose the version...
    const [row] = await getDb(appEnv).queryMany<{ next_attempt_at: string }>(
      `SELECT next_attempt_at FROM workflow_action_secret_retirements
        WHERE secret_version_ref = ?`,
      [stored.secretVersionRef]
    );
    expect(row).toBeDefined();
    // ...but not yet due to anyone.
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    await retireOrphanedActionSecrets(appEnv);

    expect(gcpMock.destroyVersion).not.toHaveBeenCalled();
    expect(await retirementRows(stored.secretVersionRef)).toHaveLength(1);
  });

  it("refuses the create and takes the version back when the obligation cannot be recorded", async () => {
    retirementQueueControl.failRecordRetirement = true;

    await expect(
      submitRpcConnection(serviceContext(PROJECT_UNRECORDABLE), submitInput("Unrecordable"))
    ).rejects.toThrow(/durably recorded/i);

    // Fail closed: the version this request wrote was destroyed immediately —
    // no credential may exist with no durable record that it exists...
    expect(gcpMock.destroyVersion).toHaveBeenCalledTimes(1);
    // ...and no rows were created for a connection that never came to be.
    const credentials = await getDb(appEnv).queryMany<{ id: string }>(
      `SELECT id FROM provider_credentials WHERE organization_id = ? AND label = 'Unrecordable'`,
      [ORG_ID]
    );
    expect(credentials).toEqual([]);
  });

  it("retries the destroy and admits the leak when neither recording nor destroying works", async () => {
    // The terminal case: the queue is unwritable AND the backend refuses the
    // destroy, so the version this request wrote survives with nothing on
    // record. Nothing may report that as a clean slate.
    retirementQueueControl.failRecordRetirement = true;
    gcpMock.destroyVersion.mockRejectedValue(new Error("secret manager unavailable"));
    const logError = vi.spyOn(getLogger(), "error");

    await expect(
      submitRpcConnection(serviceContext(PROJECT_LEAKED), submitInput("Leaked"))
    ).rejects.toThrow(/could not be completed and could not be recorded/i);

    // The destroy is the only thing that can still end the leak once the queue
    // is unwritable, so a single blip must not be taken for an answer.
    expect(gcpMock.destroyVersion.mock.calls.length).toBeGreaterThan(1);
    // Nothing will collect this one — the flag is what summons a human.
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ queuedForRetry: false, reason: "secret_cleanup_failed" }),
      "credential_secret_orphan_risk"
    );
    // The credential still never became a row.
    const credentials = await getDb(appEnv).queryMany<{ id: string }>(
      `SELECT id FROM provider_credentials WHERE organization_id = ? AND label = 'Leaked'`,
      [ORG_ID]
    );
    expect(credentials).toEqual([]);
    logError.mockRestore();
  });

  it("keeps a durable obligation when the transaction fails and the destroy also fails", async () => {
    gcpMock.destroyVersion.mockRejectedValue(new Error("secret manager unavailable"));

    // A rejected credential insert stands in for any mid-transaction failure
    // after the secret write landed — the window the pre-commit obligation
    // exists to cover.
    const insertCredential = vi
      .spyOn(ProviderCredentialStore.prototype, "insertCredential")
      .mockRejectedValue(new Error("credential insert failed"));

    try {
      await expect(
        submitRpcConnection(serviceContext(PROJECT_DOOMED), submitInput("Doomed"))
      ).rejects.toThrow();
    } finally {
      insertCredential.mockRestore();
    }

    const rows = await retirementRows("projects/sdp-test/secrets/pcred_%");
    expect(rows).toHaveLength(1);

    // Cleanup recovery: the sweeper destroys what the request could not.
    gcpMock.destroyVersion.mockResolvedValue(undefined);
    const swept = await retireOrphanedActionSecrets(appEnv);
    expect(swept.retired).toBeGreaterThanOrEqual(1);
    expect(gcpMock.destroyVersion).toHaveBeenCalledWith({
      secretVersionRef: rows[0].secret_version_ref,
    });
    expect(await retirementRows("projects/sdp-test/secrets/pcred_%")).toEqual([]);
  });

  it("destroys the stored version durably on deactivation", async () => {
    const { connectionId, versionRef } = await seedGcpConnection("deact_ok");

    const deactivated = await deactivateRpcConnection(serviceContext(), connectionId);

    expect(deactivated.status).toBe("deactivated");
    expect(gcpMock.destroyVersion).toHaveBeenCalledWith({ secretVersionRef: versionRef });
    // Destroyed immediately, so the obligation queued by the deactivating
    // transaction has been discharged.
    expect(await retirementRows(versionRef)).toEqual([]);
  });

  it("leaves the obligation queued when the deactivation destroy fails, until the sweeper collects it", async () => {
    const { connectionId, versionRef } = await seedGcpConnection("deact_fail");
    gcpMock.destroyVersion.mockRejectedValue(new Error("secret manager unavailable"));

    const deactivated = await deactivateRpcConnection(serviceContext(), connectionId);
    expect(deactivated.status).toBe("deactivated");
    expect(await retirementRows(versionRef)).toHaveLength(1);

    gcpMock.destroyVersion.mockResolvedValue(undefined);
    const swept = await retireOrphanedActionSecrets(appEnv);
    expect(swept.retired).toBeGreaterThanOrEqual(1);
    expect(await retirementRows(versionRef)).toEqual([]);
  });
});
