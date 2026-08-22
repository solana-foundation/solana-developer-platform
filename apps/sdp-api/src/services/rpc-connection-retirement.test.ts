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
import { retireOrphanedActionSecrets } from "@/services/jobs/retire-workflow-secrets";
import { deactivateRpcConnection, submitRpcConnection } from "@/services/rpc-connection.service";
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

const ORG_ID = "org_rpc_retirement";
const USER_ID = "usr_rpc_retirement";
const appEnv = env as unknown as Env;

function serviceContext(organizationId = ORG_ID) {
  const values: Record<string, unknown> = {
    clerk: {
      userId: USER_ID,
      organizationId,
      role: "admin",
      permissions: ["org:read", "org:write", "org:admin"],
    },
    projectId: null,
  };
  return {
    env: appEnv,
    get: (key: string) => values[key],
  } as unknown as Parameters<typeof submitRpcConnection>[0];
}

function submitInput(label: string) {
  return {
    provider: "helius" as const,
    network: "devnet" as const,
    scope: "organization" as const,
    credentialLabel: label,
    endpointUrl: "https://devnet.helius-rpc.com",
    apiKey: "tenant-key-retirement",
  };
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
    const connection = await submitRpcConnection(serviceContext(), submitInput("Committed"));

    expect(connection.status).toBe("pending");
    // The rows reference the version, so nothing may destroy it — the
    // provisional obligation must have been cancelled by the same commit.
    expect(await retirementRows("projects/sdp-test/secrets/pcred_%")).toEqual([]);
    expect(gcpMock.destroyVersion).not.toHaveBeenCalled();
  });

  it("refuses the create and takes the version back when the obligation cannot be recorded", async () => {
    retirementQueueControl.failRecordRetirement = true;

    await expect(
      submitRpcConnection(serviceContext(), submitInput("Unrecordable"))
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

  it("keeps a durable obligation when the transaction fails and the destroy also fails", async () => {
    gcpMock.destroyVersion.mockRejectedValue(new Error("secret manager unavailable"));

    // A missing organization fails the credential insert's foreign key — the
    // shape of any mid-transaction failure after the secret write landed.
    await expect(
      submitRpcConnection(serviceContext("org_rpc_retirement_missing"), submitInput("Doomed"))
    ).rejects.toThrow();

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
