/**
 * Lifecycle of a managed webhook endpoint's signing secret, through the real route stack.
 *
 * The registry writes the secret to the credential store BEFORE the row that references it
 * exists (secret_storage is NOT NULL), so every write here has a window where a version is
 * live in the backend and nothing points at it. Three failure modes this pins:
 *
 *  - A create whose insert never commits used to leave that version live forever: nothing
 *    referenced it, nothing recorded it, and no code path would ever try again.
 *  - Rotation destroyed the displaced grace key BEFORE writing the row. A rejected write
 *    then left the endpoint still naming a version that no longer existed — and because an
 *    unreadable live previous key correctly fails closed, every delivery failed until the
 *    grace window expired.
 *  - Rotation and delete resolved "which version am I displacing" from a read taken before
 *    the write, so a rotation that committed in between made them retire the wrong one.
 *
 * The fix in all three cases is ordering, not narrowing: the obligation to destroy a version
 * is committed before the write that would reference it, and discharged by that write's own
 * transaction. The request-time destroy becomes an optimisation that clears the row early.
 *
 * The credential store is faked so a test can mint predictable versions and fail a destroy
 * on demand; everything below it — handlers, endpoint-secret, repository — is real.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import type { StoredCredentialSecret } from "@/services/credential-secret-store";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const secretStore = vi.hoisted(() => ({
  storageBackend: "gcp_secret_manager" as const,
  write: vi.fn(),
  read: vi.fn(),
  destroyVersion: vi.fn(),
}));
const createCredentialSecretStore = vi.hoisted(() => vi.fn());

// Only the factory is replaced: CredentialSecretStoreError has to stay the real class,
// since endpoint-secret.ts narrows on `instanceof` to decide UNAVAILABLE vs rethrow.
vi.mock("@/services/credential-secret-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/credential-secret-store")>()),
  createCredentialSecretStore,
}));

// Set to make the corresponding repository write reject, standing in for the Postgres
// errors the driver propagates (constraint violation, statement timeout, dropped
// connection). Everything else delegates to the real repository.
const repoRejects = vi.hoisted(
  () =>
    ({
      createEndpoint: null,
      rotateSecret: null,
    }) as Record<string, Error | null>
);

// Rejects from the Nth queue write of a request onward. Positional on purpose: a test needs
// to let the PRE-COMMIT write through (the database was reachable then) and fail only what
// follows a failed primary write, which is the realistic shape of the reported scenario.
//
// This intercepts the REPOSITORY only. The transactional insert and delete go through
// `insertWorkflowSecretRetirement` / `deleteWorkflowSecretRetirement` directly and are
// deliberately not stubbed out — they are the mechanism under test.
const retirementWritesFail = vi.hoisted(() => ({ fromCall: null as number | null, calls: 0 }));

// Rewrites the version ref the handler's pre-transaction read reports, standing in for a
// concurrent request that committed a rotation after this one read the endpoint. A real
// interleaving cannot be forced deterministically from a single-process test; the observable
// cause is the handler acting on a row that no longer matches, which this reproduces exactly.
const staleEndpointRead = vi.hoisted(() => ({ secretVersionRef: null as string | null }));

vi.mock("@/db/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/repositories")>();
  return {
    ...actual,
    createWebhookEndpointsRepository: (
      repoEnv: Parameters<typeof actual.createWebhookEndpointsRepository>[0]
    ) => {
      const repo = actual.createWebhookEndpointsRepository(repoEnv);
      const wrapped: typeof repo = {
        ...repo,
        createEndpoint(input: Parameters<typeof repo.createEndpoint>[0]) {
          return repoRejects.createEndpoint
            ? Promise.reject(repoRejects.createEndpoint)
            : repo.createEndpoint.call(wrapped, input);
        },
        rotateSecret(input: Parameters<typeof repo.rotateSecret>[0]) {
          return repoRejects.rotateSecret
            ? Promise.reject(repoRejects.rotateSecret)
            : repo.rotateSecret.call(wrapped, input);
        },
        getEndpointById(input: Parameters<typeof repo.getEndpointById>[0]) {
          const result = repo.getEndpointById.call(wrapped, input);
          if (staleEndpointRead.secretVersionRef === null) {
            return result;
          }
          return result.then((row) =>
            row
              ? {
                  ...row,
                  secret_storage: {
                    ...row.secret_storage,
                    secretVersionRef: staleEndpointRead.secretVersionRef as string,
                  },
                }
              : row
          );
        },
      };
      return wrapped;
    },
    createWorkflowSecretRetirementsRepository: (
      repoEnv: Parameters<typeof actual.createWorkflowSecretRetirementsRepository>[0]
    ) => {
      const repo = actual.createWorkflowSecretRetirementsRepository(repoEnv);
      return {
        ...repo,
        recordRetirement(input: Parameters<typeof repo.recordRetirement>[0]) {
          retirementWritesFail.calls += 1;
          return retirementWritesFail.fromCall !== null &&
            retirementWritesFail.calls >= retirementWritesFail.fromCall
            ? Promise.reject(new Error("Connection terminated unexpectedly"))
            : repo.recordRetirement(input);
        },
      };
    },
  };
});

const WRITE_KEY = { id: "key_wh_secret", raw: "sk_test_wh_secret", prefix: "sk_test_wh_s" };
const WRITE_PERMISSIONS = ["webhooks:read", "webhooks:write"];

const SECRET_REF = "projects/p/secrets/sdp-webhook-endpoint-1";
const versionRef = (version: number) => `${SECRET_REF}/versions/${version}`;

function cachedKey(id: string, permissions: string[]): CachedApiKey {
  return {
    id,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    role: "api_admin",
    permissions,
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
    rotationDeadline: null,
  } as CachedApiKey;
}

function request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${WRITE_KEY.raw}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env
  );
}

const base = "/v1/webhook-endpoints";

async function createEndpoint() {
  const res = await request("POST", base, {
    url: "https://example.com/hooks/sdp",
    label: "Secret lifecycle endpoint",
  });
  expect(res.status).toBe(201);
  const { data } = (await res.json()) as { data: { endpoint: { id: string } } };
  return data.endpoint.id;
}

// `gracePeriodHours: 0` retires the outgoing key immediately instead of keeping it live.
async function rotate(endpointId: string, gracePeriodHours?: number) {
  return request(
    "POST",
    `${base}/${endpointId}/rotate-secret`,
    gracePeriodHours === undefined ? {} : { gracePeriodHours }
  );
}

async function storedEndpoint(endpointId: string) {
  return getDb(env)
    .prepare(
      `SELECT secret_storage, previous_secret_storage, previous_secret_expires_at, secret_version,
              deleted_at
         FROM webhook_endpoints WHERE id = ?`
    )
    .bind(endpointId)
    .first<{
      secret_storage: StoredCredentialSecret;
      previous_secret_storage: StoredCredentialSecret | null;
      previous_secret_expires_at: string | null;
      secret_version: number;
      deleted_at: string | null;
    }>();
}

// The durable queue the sweeper drains: what a destroy that could not happen left behind.
// Sorted rather than creation-ordered — rows written by one transaction share a timestamp.
async function queuedRetirements() {
  const result = await getDb(env)
    .prepare("SELECT secret_version_ref FROM workflow_action_secret_retirements")
    .all<{ secret_version_ref: string }>();
  return result.results.map((row) => row.secret_version_ref).sort();
}

async function endpointCount() {
  const row = await getDb(env)
    .prepare("SELECT COUNT(*)::int AS total FROM webhook_endpoints")
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

describe("webhook endpoint signing-secret lifecycle (routes)", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    repoRejects.createEndpoint = null;
    repoRejects.rotateSecret = null;
    retirementWritesFail.fromCall = null;
    retirementWritesFail.calls = 0;
    staleEndpointRead.secretVersionRef = null;
    createCredentialSecretStore.mockReturnValue(secretStore);
    // Each write mints the next version, the way Secret Manager's addVersion does — the
    // difference between the old and new ref is what the retirement logic keys on.
    let version = 0;
    secretStore.write.mockImplementation(async () => {
      version += 1;
      return {
        storageBackend: "gcp_secret_manager",
        secretRef: SECRET_REF,
        secretVersionRef: versionRef(version),
      };
    });
    secretStore.destroyVersion.mockResolvedValue(undefined);

    const db = getDb(env);
    const kv = createKVStoreSet(env);

    const rateLimitKeys = await kv.rateLimits.list();
    for (const key of rateLimitKeys.keys) {
      await kv.rateLimits.delete(key.name);
    }

    await db.prepare("DELETE FROM workflow_action_secret_retirements").run();
    await db.prepare("DELETE FROM webhook_deliveries").run();
    await db.prepare("DELETE FROM webhook_endpoints").run();
    await db.prepare("DELETE FROM api_keys WHERE project_id IS NOT NULL").run();
    await db.prepare("DELETE FROM projects").run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await db
      .prepare(
        `INSERT OR REPLACE INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_ORG.id,
        TEST_PROJECT.name,
        TEST_PROJECT.slug,
        TEST_PROJECT.environment,
        TEST_USER.id
      )
      .run();

    const hash = await hashString(
      WRITE_KEY.raw,
      (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER
    );
    await db
      .prepare(
        `INSERT OR REPLACE INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'wh secret key', ?, ?, 'api_admin', ?, 'active')`
      )
      .bind(
        WRITE_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        WRITE_KEY.prefix,
        hash,
        JSON.stringify(WRITE_PERMISSIONS)
      )
      .run();
    await kv.apiKeys.put(`key:${hash}`, JSON.stringify(cachedKey(WRITE_KEY.id, WRITE_PERMISSIONS)));
  });

  // The steady state: every version a successful request writes ends up referenced, so the
  // queue is empty. A row surviving here would have the sweeper destroy a live signing key.
  describe("when every write succeeds", () => {
    it("leaves nothing queued after a create", async () => {
      const endpointId = await createEndpoint();

      expect(await queuedRetirements()).toEqual([]);
      expect((await storedEndpoint(endpointId))?.secret_storage.secretVersionRef).toBe(
        versionRef(1)
      );
      expect(secretStore.destroyVersion).not.toHaveBeenCalled();
    });

    it("leaves nothing queued after a rotation, and keeps both keys live", async () => {
      const endpointId = await createEndpoint();

      const res = await rotate(endpointId);

      expect(res.status).toBe(200);
      const row = await storedEndpoint(endpointId);
      expect(row?.secret_storage.secretVersionRef).toBe(versionRef(2));
      // The displaced current key stays live for receivers mid-cutover, so nothing is
      // destroyed and nothing is owed.
      expect(row?.previous_secret_storage?.secretVersionRef).toBe(versionRef(1));
      expect(row?.secret_version).toBe(2);
      expect(await queuedRetirements()).toEqual([]);
      expect(secretStore.destroyVersion).not.toHaveBeenCalled();
    });

    it("destroys the outgoing key immediately when the rotation asks for no grace", async () => {
      const endpointId = await createEndpoint();

      const res = await rotate(endpointId, 0);

      expect(res.status).toBe(200);
      const row = await storedEndpoint(endpointId);
      expect(row?.previous_secret_storage).toBeNull();
      expect(row?.previous_secret_expires_at).toBeNull();
      expect(secretStore.destroyVersion).toHaveBeenCalledWith({
        secretVersionRef: versionRef(1),
      });
      // Destroyed, so the obligation the rotation committed is discharged.
      expect(await queuedRetirements()).toEqual([]);
    });

    it("destroys the key a second rotation pushes out of the grace slot", async () => {
      const endpointId = await createEndpoint();
      await rotate(endpointId);

      const res = await rotate(endpointId);

      expect(res.status).toBe(200);
      const row = await storedEndpoint(endpointId);
      expect(row?.secret_storage.secretVersionRef).toBe(versionRef(3));
      expect(row?.previous_secret_storage?.secretVersionRef).toBe(versionRef(2));
      expect(secretStore.destroyVersion).toHaveBeenCalledWith({
        secretVersionRef: versionRef(1),
      });
      expect(await queuedRetirements()).toEqual([]);
    });
  });

  // The window a retry could never close: the destroy fails, so the queued row is the only
  // durable record that the version is still alive, and the sweeper reads nothing else.
  describe("when the destroy fails", () => {
    beforeEach(() => {
      secretStore.destroyVersion.mockRejectedValue(new Error("permission denied"));
    });

    it("keeps the version a rotation displaced out of the grace slot queued", async () => {
      const endpointId = await createEndpoint();
      await rotate(endpointId);

      const res = await rotate(endpointId);

      expect(res.status).toBe(200);
      // Only the one nobody references. v2 is the live grace key and v3 is what the endpoint
      // now signs with; queueing either would have the sweeper destroy a working key.
      expect(await queuedRetirements()).toEqual([versionRef(1)]);
    });

    it("keeps a no-grace rotation's outgoing key queued", async () => {
      const endpointId = await createEndpoint();

      const res = await rotate(endpointId, 0);

      expect(res.status).toBe(200);
      expect(await queuedRetirements()).toEqual([versionRef(1)]);
    });

    it("keeps both of a deleted endpoint's keys queued", async () => {
      const endpointId = await createEndpoint();
      await rotate(endpointId);

      const res = await request("DELETE", `${base}/${endpointId}`);

      expect(res.status).toBe(200);
      // Nothing signs with a deleted endpoint, so current AND the live grace key are both
      // orphaned by the same commit. The delivery log the soft delete preserves holds
      // bodies, never secrets.
      expect(await queuedRetirements()).toEqual([versionRef(1), versionRef(2)].sort());
    });

    // The retry of a delete whose cleanup died: the row is already soft-deleted, so the
    // 404 is correct, but its keys are still alive and still owed.
    it("re-queues the keys of an endpoint that was already deleted", async () => {
      const endpointId = await createEndpoint();
      await rotate(endpointId);
      await request("DELETE", `${base}/${endpointId}`);
      await getDb(env).prepare("DELETE FROM workflow_action_secret_retirements").run();

      const res = await request("DELETE", `${base}/${endpointId}`);

      expect(res.status).toBe(404);
      expect(await queuedRetirements()).toEqual([versionRef(1), versionRef(2)].sort());
    });
  });

  // The rollback paths, where nothing commits and there is therefore no transaction to
  // join. Covered by queueing the obligation BEFORE the write is attempted: call 1 (the
  // pre-commit write) lands while the database is still reachable, and every write after it
  // fails, which is what a request whose primary write died looks like.
  describe("when the write never commits", () => {
    beforeEach(() => {
      secretStore.destroyVersion.mockRejectedValue(new Error("permission denied"));
    });

    it("keeps an uncommitted create's version queued", async () => {
      retirementWritesFail.fromCall = 2;
      repoRejects.createEndpoint = new Error("deadlock detected");

      const res = await request("POST", base, {
        url: "https://example.com/hooks/sdp",
        label: "Never committed",
      });

      expect(res.status).toBe(500);
      expect(await endpointCount()).toBe(0);
      expect(await queuedRetirements()).toEqual([versionRef(1)]);
    });

    it("keeps an uncommitted rotation's new version queued", async () => {
      const endpointId = await createEndpoint();
      // Counted per request, not per test: the setup create consumed a call of its own.
      retirementWritesFail.calls = 0;
      retirementWritesFail.fromCall = 2;
      repoRejects.rotateSecret = new Error("deadlock detected");

      const res = await rotate(endpointId);

      expect(res.status).toBe(500);
      // The endpoint still signs with v1, which must survive. v2 is the one nobody
      // references — and v1 must NOT be queued, since the live row still points at it.
      expect((await storedEndpoint(endpointId))?.secret_storage.secretVersionRef).toBe(
        versionRef(1)
      );
      expect(await queuedRetirements()).toEqual([versionRef(2)]);
    });

    // The ordering regression itself. Destroying the displaced key before the write meant a
    // rejected rotation left the endpoint naming a grace version that no longer existed;
    // since an unreadable live previous key fails closed, deliveries then failed outright
    // until the grace expired.
    it("does not touch the backend until the rotation has committed", async () => {
      const endpointId = await createEndpoint();
      await rotate(endpointId);
      secretStore.destroyVersion.mockClear();
      repoRejects.rotateSecret = new Error("deadlock detected");

      const res = await rotate(endpointId);

      expect(res.status).toBe(500);
      expect(secretStore.destroyVersion).not.toHaveBeenCalled();
      // Both keys the endpoint still names are intact and unqueued.
      const row = await storedEndpoint(endpointId);
      expect(row?.secret_storage.secretVersionRef).toBe(versionRef(2));
      expect(row?.previous_secret_storage?.secretVersionRef).toBe(versionRef(1));
      expect(await queuedRetirements()).not.toContain(versionRef(1));
      expect(await queuedRetirements()).not.toContain(versionRef(2));
    });
  });

  // What the handler read before the transaction is never the authority on which version is
  // being displaced. A rotation that commits in between makes that read name a version that
  // is already retired: acting on it would write the retired one back as the live grace key
  // and orphan the one the row actually holds.
  it("resolves the displaced version from the row under lock, not from the caller's read", async () => {
    const endpointId = await createEndpoint();
    await rotate(endpointId);
    secretStore.destroyVersion.mockClear();
    // The handler now sees the endpoint as it looked before that rotation.
    staleEndpointRead.secretVersionRef = versionRef(1);

    const res = await rotate(endpointId);

    expect(res.status).toBe(200);
    const row = await storedEndpoint(endpointId);
    // v2 — what the row actually held — becomes the grace key, not the stale v1.
    expect(row?.previous_secret_storage?.secretVersionRef).toBe(versionRef(2));
    expect(row?.secret_storage.secretVersionRef).toBe(versionRef(3));
    // And v1, which the stale read would have kept live, is the one retired.
    expect(secretStore.destroyVersion).toHaveBeenCalledWith({ secretVersionRef: versionRef(1) });
    expect(secretStore.destroyVersion).not.toHaveBeenCalledWith({
      secretVersionRef: versionRef(2),
    });
  });
});
