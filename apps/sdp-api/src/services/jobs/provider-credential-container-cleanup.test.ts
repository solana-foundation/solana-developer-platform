// Real PostgreSQL and the external GCP secret-store seam.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { rootLogger } from "@/runtime/logger";
import {
  type CredentialSecretStore,
  type CredentialSecretVersionPage,
  GcpSecretManagerCredentialSecretStore,
} from "@/services/credential-secret-store";
import { ProviderCredentialStore } from "@/services/stores/provider-credential.store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { scanGcpCredentialContainers } from "./provider-credential-container-cleanup";

const ORG = "org_shared_cleanup_prototype";
const USER = "usr_shared_cleanup_prototype";
const PARENT = "projects/1234567890/secrets/sdp-provider-credentials-prototype";
const ref = (version: number) => `${PARENT}/versions/${version}`;

function fakeGcp() {
  const versions = new Map<string, "ENABLED" | "DESTROYED">();
  const listVersions = vi.fn(
    async (): Promise<CredentialSecretVersionPage> => ({
      versions: [...versions].map(([secretVersionRef, state]) => ({ secretVersionRef, state })),
    })
  );
  const destroyVersion = vi.fn(async ({ secretVersionRef }: { secretVersionRef: string }) => {
    const canonicalRef = secretVersionRef.replace("projects/test-project/", "projects/1234567890/");
    if (!versions.has(canonicalRef)) throw new Error("GCP version not found");
    versions.set(canonicalRef, "DESTROYED");
  });
  const secrets: CredentialSecretStore = {
    storageBackend: "gcp_secret_manager",
    predictFirstVersionRef: () => null,
    write: vi.fn(async () => {
      throw new Error("Use controlled writes in this prototype");
    }),
    read: vi.fn(async () => {
      throw new Error("Cleanup must not read payloads");
    }),
    listVersions,
    destroyVersion,
  };
  return { versions, listVersions, destroyVersion, secrets };
}

async function reserve(id: string, version: number, predecessor: string | null = null) {
  const row = await new ProviderCredentialStore(getDb(env)).insertCredential({
    id,
    organizationId: ORG,
    projectId: null,
    provider: "privy",
    label: "Prototype",
    scope: "organization",
    source: "stored",
    status: "creating",
    stored: { storageBackend: "gcp_secret_manager", secretRef: PARENT },
    displayMetadata: {},
    version,
    rotatedFromId: predecessor,
    idempotencyKey: id,
    idempotencyFingerprint: id,
    createdBy: USER,
    ownsGcpContainer: version === 1,
  });
  if (version === 1) {
    await getDb(env).execute(
      "UPDATE provider_credentials SET secret_next_scan_at = '2020-01-01' WHERE id = ?",
      [id]
    );
  }
  return row;
}

async function finalize(id: string, version: number) {
  return new ProviderCredentialStore(getDb(env)).finalizeCredentialCreation({
    organizationId: ORG,
    credentialId: id,
    secretRef: PARENT,
    secretVersionRef: ref(version),
  });
}

describe("shared-container orphan cleanup", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env).execute(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Prototype', 'shared-prototype', 'enterprise', 'active')",
      [ORG]
    );
    await getDb(env).execute(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'shared-prototype@example.test', 1, 'active')",
      [USER]
    );
  });

  it("destroys an unreferenced version while preserving active and retained rollback versions", async () => {
    const log = vi.spyOn(rootLogger, "info").mockImplementation(() => rootLogger);
    const gcp = fakeGcp();
    await reserve("pcred_proto_previous", 1);
    await finalize("pcred_proto_previous", 1);
    await getDb(env).execute(
      "UPDATE provider_credentials SET status = 'retired', secret_retention_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
      ["pcred_proto_previous"]
    );
    await reserve("pcred_proto_current", 2, "pcred_proto_previous");
    await finalize("pcred_proto_current", 2);
    await getDb(env).execute("UPDATE provider_credentials SET status = 'active' WHERE id = ?", [
      "pcred_proto_current",
    ]);
    for (const version of [1, 2, 3]) gcp.versions.set(ref(version), "ENABLED");

    await scanGcpCredentialContainers(env, () => gcp.secrets);

    expect([...gcp.versions.values()]).toEqual(["ENABLED", "ENABLED", "DESTROYED"]);
    expect(log).toHaveBeenCalledWith(
      {
        organizationId: ORG,
        containerOwnerCredentialId: "pcred_proto_previous",
        providerCredentialId: undefined,
        secretRef: PARENT,
        secretVersionRef: ref(3),
        outcome: "confirmed_destroyed",
        kind: "unreferenced_version",
      },
      "provider_credential_secret_destroyed"
    );
  });

  it("preserves an active project-ID version when GCP inventory uses the project number", async () => {
    const gcp = fakeGcp();
    await reserve("pcred_alias_active", 1);
    await finalize("pcred_alias_active", 1);
    await getDb(env).execute(
      "UPDATE provider_credentials SET status = 'active', secret_ref = ?, secret_version_ref = ? WHERE id = ?",
      [
        PARENT.replace("1234567890", "test-project"),
        ref(1).replace("1234567890", "test-project"),
        "pcred_alias_active",
      ]
    );
    for (const version of [1, 2]) gcp.versions.set(ref(version), "ENABLED");

    const result = await scanGcpCredentialContainers(env, () => gcp.secrets);

    expect(gcp.versions.get(ref(1))).toBe("ENABLED");
    expect(gcp.versions.get(ref(2))).toBe("DESTROYED");
    expect(result).toMatchObject({ cleaned: 1, failed: [] });
  });

  it("does not destroy a retained version also referenced through its project-number alias", async () => {
    const gcp = fakeGcp();
    await reserve("pcred_alias_retired", 1);
    await finalize("pcred_alias_retired", 1);
    await getDb(env).execute(
      "UPDATE provider_credentials SET status = 'retired', secret_retention_expires_at = '2020-01-01T00:00:00.000Z', secret_version_ref = ? WHERE id = ?",
      [ref(1).replace("1234567890", "test-project"), "pcred_alias_retired"]
    );
    await reserve("pcred_alias_duplicate", 2, "pcred_alias_retired");
    await finalize("pcred_alias_duplicate", 1);
    await getDb(env).execute("UPDATE provider_credentials SET status = 'active' WHERE id = ?", [
      "pcred_alias_duplicate",
    ]);
    gcp.versions.set(ref(1), "ENABLED");

    const result = await scanGcpCredentialContainers(env, () => gcp.secrets);

    expect(gcp.destroyVersion).not.toHaveBeenCalled();
    expect(gcp.versions.get(ref(1))).toBe("ENABLED");
    expect(result.failed).toEqual([PARENT]);
  });

  it("preserves a written version while its acknowledged writer has not finalized", async () => {
    const gcp = fakeGcp();
    await reserve("pcred_proto_inflight", 1);
    gcp.versions.set(ref(1), "ENABLED");

    const result = await scanGcpCredentialContainers(env, () => gcp.secrets);

    expect(gcp.versions.get(ref(1))).toBe("ENABLED");
    expect(result.skipped).toBe(1);
    expect(await finalize("pcred_proto_inflight", 1)).toMatchObject({ status: "pending" });
  });

  it("retains cleanup work and never confirms retained or orphan destruction while GCP only schedules it", async () => {
    const log = vi.spyOn(rootLogger, "info").mockImplementation(() => rootLogger);
    await reserve("pcred_delayed_destroy", 1);
    await finalize("pcred_delayed_destroy", 1);
    await getDb(env).execute(
      "UPDATE provider_credentials SET status = 'retired', secret_retention_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
      ["pcred_delayed_destroy"]
    );
    let destroyed = false;
    const secrets = new GcpSecretManagerCredentialSecretStore({
      projectId: "test-project",
      projectNumber: "1234567890",
      secretPrefix: "sdp-provider-credentials",
      accessToken: "test-token",
      fetcher: async (input) => {
        const url = new URL(String(input));
        const state = destroyed ? "DESTROYED" : "DISABLED";
        if (url.pathname.endsWith("/versions")) {
          return Response.json({
            versions: destroyed ? [] : [1, 2].map((n) => ({ name: ref(n), state })),
          });
        }
        return Response.json({
          name: url.pathname.slice(4).replace(/:destroy$/, ""),
          state,
          ...(destroyed ? {} : { scheduledDestroyTime: "2099-01-01T00:00:00Z" }),
        });
      },
    });

    const marker = () =>
      getDb(env).queryOne<{ pending: boolean }>(
        "SELECT secret_retention_expires_at IS NOT NULL AS pending FROM provider_credentials WHERE id = ?",
        ["pcred_delayed_destroy"]
      );
    await expect(scanGcpCredentialContainers(env, () => secrets)).resolves.toMatchObject({
      cleaned: 0,
      failed: [PARENT],
    });
    expect(await marker()).toEqual({ pending: true });
    expect(log).not.toHaveBeenCalledWith(expect.anything(), "provider_credential_secret_destroyed");

    destroyed = true;
    await expect(
      scanGcpCredentialContainers(env, () => secrets, {
        now: new Date(Date.now() + 6 * 60_000),
      })
    ).resolves.toMatchObject({ cleaned: 1, failed: [] });
    expect(await marker()).toEqual({ pending: false });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ secretVersionRef: ref(1), outcome: "confirmed_destroyed" }),
      "provider_credential_secret_destroyed"
    );
  });

  it("cancels stale creation before destruction and rejects its late finalization", async () => {
    const gcp = fakeGcp();
    await reserve("pcred_proto_stale", 1);
    await getDb(env).execute(
      "UPDATE provider_credentials SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
      ["pcred_proto_stale"]
    );
    gcp.versions.set(ref(1), "ENABLED");
    gcp.destroyVersion.mockImplementationOnce(async ({ secretVersionRef }) => {
      expect(await finalize("pcred_proto_stale", 1)).toBeNull();
      gcp.versions.set(secretVersionRef, "DESTROYED");
    });

    await scanGcpCredentialContainers(env, () => gcp.secrets);

    expect(gcp.versions.get(ref(1))).toBe("DESTROYED");
    expect(await finalize("pcred_proto_stale", 1)).toBeNull();
  });

  it("collects orphan versions from every inventory page", async () => {
    const gcp = fakeGcp();
    await reserve("pcred_proto_pages", 1);
    await finalize("pcred_proto_pages", 1);
    for (const version of [1, 2, 3]) gcp.versions.set(ref(version), "ENABLED");
    gcp.listVersions
      .mockResolvedValueOnce({
        versions: [
          { secretVersionRef: ref(1), state: "ENABLED" },
          { secretVersionRef: ref(2), state: "ENABLED" },
        ],
        nextPageToken: "page-2",
      })
      .mockResolvedValueOnce({ versions: [{ secretVersionRef: ref(3), state: "ENABLED" }] });

    await scanGcpCredentialContainers(env, () => gcp.secrets);

    expect([...gcp.versions.values()]).toEqual(["ENABLED", "DESTROYED", "DESTROYED"]);
  });

  it("uses DB references committed during inventory instead of a stale pre-inventory view", async () => {
    const gcp = fakeGcp();
    await reserve("pcred_proto_existing", 1);
    await finalize("pcred_proto_existing", 1);
    gcp.versions.set(ref(1), "ENABLED");
    gcp.listVersions.mockImplementationOnce(async () => {
      await reserve("pcred_proto_during_list", 2, "pcred_proto_existing");
      gcp.versions.set(ref(2), "ENABLED");
      await finalize("pcred_proto_during_list", 2);
      return {
        versions: [...gcp.versions].map(([secretVersionRef, state]) => ({
          secretVersionRef,
          state,
        })),
      };
    });

    await scanGcpCredentialContainers(env, () => gcp.secrets);

    expect([...gcp.versions.values()]).toEqual(["ENABLED", "ENABLED"]);
  });

  it("recovers a version whose add response was lost after the attempt was cancelled", async () => {
    const gcp = fakeGcp();
    await reserve("pcred_proto_lost_reply", 1);
    vi.mocked(gcp.secrets.write).mockImplementationOnce(async () => {
      gcp.versions.set(ref(1), "ENABLED");
      throw new Error("Response lost after GCP accepted the write");
    });
    await expect(
      gcp.secrets.write({
        orgId: ORG,
        provider: "privy",
        providerCredentialId: "pcred_proto_lost_reply",
        existingSecretRef: PARENT,
        payload: { appId: "test", appSecret: "test-only" },
      })
    ).rejects.toThrow("Response lost");
    await new ProviderCredentialStore(getDb(env)).abandonCredentialCreation({
      organizationId: ORG,
      credentialId: "pcred_proto_lost_reply",
    });

    await scanGcpCredentialContainers(env, () => gcp.secrets);

    expect(gcp.versions.get(ref(1))).toBe("DESTROYED");
  });

  it("finds a late version even after the attempt's absence marker was closed", async () => {
    const gcp = fakeGcp();
    await reserve("pcred_proto_late", 1);
    await new ProviderCredentialStore(getDb(env)).abandonCredentialCreation({
      organizationId: ORG,
      credentialId: "pcred_proto_late",
    });
    await getDb(env).execute(
      `UPDATE provider_credentials SET secret_retention_expires_at = NULL,
         secret_cleanup_outcome = 'assumed_absent', secret_cleanup_absent_since = '2020-01-01T00:00:00.000Z'
       WHERE id = ?`,
      ["pcred_proto_late"]
    );
    await scanGcpCredentialContainers(env, () => gcp.secrets);
    // No request-local version ref or cleanup queue survives into the next pass.
    // The persisted container is the reason this location is still visited.
    gcp.versions.set(ref(1), "ENABLED");

    await scanGcpCredentialContainers(env, () => gcp.secrets, {
      now: new Date(Date.now() + 6 * 60_000),
    });

    expect(gcp.versions.get(ref(1))).toBe("DESTROYED");
  });

  it("does not destroy a rotation started after the inventory was captured", async () => {
    const gcp = fakeGcp();
    await reserve("pcred_proto_before_sweep", 1);
    await finalize("pcred_proto_before_sweep", 1);
    gcp.versions.set(ref(1), "ENABLED");
    gcp.versions.set(ref(2), "ENABLED");
    gcp.destroyVersion.mockImplementationOnce(async ({ secretVersionRef }) => {
      await reserve("pcred_proto_during_sweep", 3, "pcred_proto_before_sweep");
      gcp.versions.set(ref(3), "ENABLED");
      await finalize("pcred_proto_during_sweep", 3);
      gcp.versions.set(secretVersionRef, "DESTROYED");
    });

    await scanGcpCredentialContainers(env, () => gcp.secrets);

    expect([...gcp.versions.values()]).toEqual(["ENABLED", "DESTROYED", "ENABLED"]);
  });

  it("converges after a lost destroy reply and a failed verification", async () => {
    const errorLog = vi.spyOn(rootLogger, "error").mockImplementation(() => rootLogger);
    const successLog = vi.spyOn(rootLogger, "info").mockImplementation(() => rootLogger);
    const gcp = fakeGcp();
    await reserve("pcred_proto_destroy_reply", 1);
    await new ProviderCredentialStore(getDb(env)).abandonCredentialCreation({
      organizationId: ORG,
      credentialId: "pcred_proto_destroy_reply",
    });
    gcp.versions.set(ref(1), "ENABLED");
    gcp.destroyVersion.mockImplementationOnce(async ({ secretVersionRef }) => {
      gcp.versions.set(secretVersionRef, "DESTROYED");
      throw new Error("Destroy reply and follow-up verification lost");
    });

    await expect(scanGcpCredentialContainers(env, () => gcp.secrets)).resolves.toMatchObject({
      failed: [PARENT],
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        secretRef: PARENT,
        secretVersionRef: ref(1),
        reason: "secret_cleanup_failed",
      }),
      "provider_credential_orphan_risk"
    );
    expect(successLog).not.toHaveBeenCalledWith(
      expect.anything(),
      "provider_credential_secret_destroyed"
    );
    await expect(
      scanGcpCredentialContainers(env, () => gcp.secrets, {
        now: new Date(Date.now() + 6 * 60_000),
      })
    ).resolves.toMatchObject({ cleaned: 0, failed: [] });

    expect(gcp.versions.get(ref(1))).toBe("DESTROYED");
  });

  it("cancels stale creation even when GCP inventory is unavailable", async () => {
    const gcp = fakeGcp();
    await reserve("pcred_proto_inventory_down", 1);
    await getDb(env).execute(
      "UPDATE provider_credentials SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
      ["pcred_proto_inventory_down"]
    );
    gcp.listVersions.mockRejectedValueOnce(new Error("GCP unavailable"));

    await expect(scanGcpCredentialContainers(env, () => gcp.secrets)).resolves.toMatchObject({
      failed: [PARENT],
    });

    expect(
      await new ProviderCredentialStore(getDb(env)).findLifecycleCredential(
        ORG,
        "pcred_proto_inventory_down"
      )
    ).toMatchObject({ status: "deactivated" });
  });

  it("logs the exact orphan version when its destroy reply is lost at the deadline", async () => {
    const warning = vi.spyOn(rootLogger, "warn").mockImplementation(() => rootLogger);
    const info = vi.spyOn(rootLogger, "info").mockImplementation(() => rootLogger);
    const gcp = fakeGcp();
    await reserve("pcred_deadline_audit", 1);
    await finalize("pcred_deadline_audit", 1);
    gcp.versions.set(ref(2), "ENABLED");
    // Advance the monotonic clock only inside the actual destroy call.
    const time = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(time);
    gcp.destroyVersion.mockImplementationOnce(async ({ secretVersionRef }) => {
      gcp.versions.set(secretVersionRef, "DESTROYED");
      clock.mockReturnValue(time + 101_000);
      throw new Error("Response lost after destruction");
    });
    await expect(scanGcpCredentialContainers(env, () => gcp.secrets)).resolves.toMatchObject({
      deadlineReached: true,
      cleaned: 0,
      failed: [],
    });
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        secretRef: PARENT,
        secretVersionRef: ref(2),
        outcome: "destruction_unconfirmed",
      }),
      "provider_credential_secret_destruction_unconfirmed"
    );
    expect(info).not.toHaveBeenCalledWith(
      expect.anything(),
      "provider_credential_secret_destroyed"
    );
  });
});
