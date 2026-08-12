/**
 * Lifecycle of a `send_webhook` rule's HMAC signing secret, through the real route stack.
 *
 * Two failure modes this pins, both of which the routes had:
 *
 *  - Non-atomic create. The rule row was inserted first and the credential attached
 *    afterwards, so a store failure answered 400 with an enabled rule already committed
 *    and its plaintext secret already stripped — the caller saw an error while a live rule
 *    posted unsigned deliveries, and each retry left another row behind.
 *  - Secrets that outlive their rule. Rotation added a version without destroying the one
 *    it replaced, and deleting a rule left its key intact, so superseded credentials stayed
 *    readable in the backend indefinitely.
 *
 * The credential store is faked so the test can fail a write on demand and observe the
 * destroy calls; everything below it — handlers, action-secret, repository — is real.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  type AssetWorkflowDefinition,
  createWorkflowExecutionsRepository,
} from "@/db/repositories";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { CredentialSecretStoreError } from "@/services/credential-secret-store";
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
// since action-secret.ts narrows on `instanceof` to decide UNAVAILABLE vs rethrow.
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
      createWorkflow: null,
      updateWorkflow: null,
      cancelOpenExecutionsForWorkflow: null,
    }) as Record<string, Error | null>
);

// Fails the Nth getWorkflowById call of a request, standing in for a dropped connection
// on a read. Positional on purpose: the rotation regression needs to fail a read that
// FOLLOWS a committed write, which no all-or-nothing switch can express.
const getWorkflowByIdFailure = vi.hoisted(() => ({
  failOnCall: null as number | null,
  calls: 0,
}));

vi.mock("@/db/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/repositories")>();
  return {
    ...actual,
    createAssetWorkflowsRepository: (
      env: Parameters<typeof actual.createAssetWorkflowsRepository>[0]
    ) => {
      const repo = actual.createAssetWorkflowsRepository(env);
      // Delegation binds `this` to the wrapped object, so a method the repository
      // calls on ITSELF (e.g. an internal read following a write) still routes
      // through these interceptors — the rotation regression depends on that.
      const wrapped: typeof repo = {
        ...repo,
        createWorkflow(input: Parameters<typeof repo.createWorkflow>[0]) {
          return repoRejects.createWorkflow
            ? Promise.reject(repoRejects.createWorkflow)
            : repo.createWorkflow.call(wrapped, input);
        },
        updateWorkflow(input: Parameters<typeof repo.updateWorkflow>[0]) {
          return repoRejects.updateWorkflow
            ? Promise.reject(repoRejects.updateWorkflow)
            : repo.updateWorkflow.call(wrapped, input);
        },
        getWorkflowById(input: Parameters<typeof repo.getWorkflowById>[0]) {
          getWorkflowByIdFailure.calls += 1;
          if (getWorkflowByIdFailure.failOnCall === getWorkflowByIdFailure.calls) {
            return Promise.reject(new Error("Connection terminated unexpectedly"));
          }
          return repo.getWorkflowById.call(wrapped, input);
        },
      };
      return wrapped;
    },
    createWorkflowExecutionsRepository: (
      env: Parameters<typeof actual.createWorkflowExecutionsRepository>[0]
    ) => {
      const repo = actual.createWorkflowExecutionsRepository(env);
      return {
        ...repo,
        cancelOpenExecutionsForWorkflow(
          input: Parameters<typeof repo.cancelOpenExecutionsForWorkflow>[0]
        ) {
          return repoRejects.cancelOpenExecutionsForWorkflow
            ? Promise.reject(repoRejects.cancelOpenExecutionsForWorkflow)
            : repo.cancelOpenExecutionsForWorkflow(input);
        },
      };
    },
  };
});

const TOKEN_ID = "tok_workflow_secret_test";
const WRITE_KEY = { id: "key_wf_secret", raw: "sk_test_wf_secret", prefix: "sk_test_wf_s" };
const WEBHOOK_URL = "https://hooks.example.com/sdp";
const SECRET = "s3cret-signing-key";
const ROTATED_SECRET = "rotated-signing-key";

const SECRET_REF = "projects/p/secrets/sdp-workflow-action-1";
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

function request(method: string, path: string, body?: unknown) {
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

const base = `/v1/issuance/tokens/${TOKEN_ID}/workflows`;

async function createRule(params: Record<string, string>) {
  return request("POST", base, {
    triggerType: "kyc_approved",
    actionType: "send_webhook",
    actionParams: params,
  });
}

async function createRuleWithSecret() {
  const res = await createRule({ url: WEBHOOK_URL, secret: SECRET });
  expect(res.status).toBe(201);
  const { data } = (await res.json()) as { data: { workflow: { id: string } } };
  return data.workflow.id;
}

async function storedRules() {
  const result = await getDb(env)
    .prepare("SELECT id, enabled, definition FROM asset_workflows ORDER BY created_at ASC")
    .all<{ id: string; enabled: boolean; definition: AssetWorkflowDefinition }>();
  return result.results;
}

describe("workflow signing-secret lifecycle (routes)", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    repoRejects.createWorkflow = null;
    repoRejects.updateWorkflow = null;
    repoRejects.cancelOpenExecutionsForWorkflow = null;
    getWorkflowByIdFailure.failOnCall = null;
    getWorkflowByIdFailure.calls = 0;
    createCredentialSecretStore.mockReturnValue(secretStore);
    // Each write mints the next version, the way Secret Manager's addVersion does — that
    // difference between the old and new ref is what rotation cleanup keys on.
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

    await db.prepare("DELETE FROM workflow_executions").run();
    await db.prepare("DELETE FROM asset_workflows").run();
    await db.prepare("DELETE FROM issued_tokens").run();
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
    await db
      .prepare(
        `INSERT OR REPLACE INTO issued_tokens
           (id, project_id, organization_id, created_by, mint_address, mint_authority,
            abl_list_address, name, symbol, decimals, template, is_mintable,
            allowlist_enabled, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Secret Test', 'SECR', 6, 'stablecoin', 1, 1, 'active')`
      )
      .bind(
        TOKEN_ID,
        TEST_PROJECT.id,
        TEST_ORG.id,
        TEST_USER.id,
        "So11111111111111111111111111111111111111112",
        "So11111111111111111111111111111111111111112",
        "So11111111111111111111111111111111111111112"
      )
      .run();

    const permissions = ["tokens:read", "tokens:write"];
    const hash = await hashString(
      WRITE_KEY.raw,
      (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER
    );
    await db
      .prepare(
        `INSERT OR REPLACE INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'wf secret key', ?, ?, 'api_admin', ?, 'active')`
      )
      .bind(
        WRITE_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        WRITE_KEY.prefix,
        hash,
        JSON.stringify(permissions)
      )
      .run();
    await kv.apiKeys.put(`key:${hash}`, JSON.stringify(cachedKey(WRITE_KEY.id, permissions)));
  });

  describe("create", () => {
    // The regression: a failed secret write used to answer 400 having already committed an
    // enabled rule whose plaintext secret was stripped — an unsigned webhook sender the
    // caller was told did not exist.
    it("leaves no rule behind when the secret write fails", async () => {
      secretStore.write.mockRejectedValue(
        new CredentialSecretStoreError("secret manager unavailable", "UPSTREAM_ERROR")
      );

      const res = await createRule({ url: WEBHOOK_URL, secret: SECRET });

      expect(res.status).toBe(400);
      expect(await storedRules()).toHaveLength(0);
    });

    // Same window from the other side: a store that is not configured at all must refuse
    // before anything is written, not after.
    it("leaves no rule behind when no store is configured", async () => {
      createCredentialSecretStore.mockImplementation(() => {
        throw new CredentialSecretStoreError("not configured", "INVALID_CONFIGURATION");
      });

      const res = await createRule({ url: WEBHOOK_URL, secret: SECRET });

      expect(res.status).toBe(400);
      expect(await storedRules()).toHaveLength(0);
    });

    it("commits the rule with a reference, never the value", async () => {
      const res = await createRule({ url: WEBHOOK_URL, secret: SECRET });

      expect(res.status).toBe(201);
      const { data } = (await res.json()) as {
        data: { workflow: { hasSecret: boolean; definition: AssetWorkflowDefinition } };
      };
      expect(data.workflow.hasSecret).toBe(true);
      expect(data.workflow.definition.action.params.secret).toBeUndefined();

      const [row] = await storedRules();
      expect(row.definition.actionSecret?.secretVersionRef).toBe(versionRef(1));
      // The plaintext must not survive anywhere in the JSONB the list endpoint reads.
      expect(JSON.stringify(row.definition)).not.toContain(SECRET);
    });

    // The realistic failure: the driver propagates Postgres errors, and an
    // `INSERT … RETURNING *` that succeeds always yields a row — so the write rejects far
    // more readily than it resolves null. Cleanup that only ran on the null result left
    // the signing-secret version alive with no rule that could ever reference it.
    it("retires the secret when the insert rejects", async () => {
      repoRejects.createWorkflow = new Error("deadlock detected");

      const res = await createRule({ url: WEBHOOK_URL, secret: SECRET });

      expect(res.status).toBe(500);
      expect(secretStore.destroyVersion).toHaveBeenCalledWith({ secretVersionRef: versionRef(1) });
      expect(await storedRules()).toHaveLength(0);
    });

    it("still creates a rule that needs no secret", async () => {
      const res = await createRule({ url: WEBHOOK_URL });

      expect(res.status).toBe(201);
      expect(secretStore.write).not.toHaveBeenCalled();
      const [row] = await storedRules();
      expect(row.definition.actionSecret ?? null).toBeNull();
    });
  });

  describe("rotation", () => {
    it("destroys the version it replaced", async () => {
      const workflowId = await createRuleWithSecret();

      const res = await request("PATCH", `${base}/${workflowId}`, {
        actionParams: { url: WEBHOOK_URL, secret: ROTATED_SECRET },
      });

      expect(res.status).toBe(200);
      expect(secretStore.destroyVersion).toHaveBeenCalledTimes(1);
      expect(secretStore.destroyVersion).toHaveBeenCalledWith({ secretVersionRef: versionRef(1) });

      // …and the rule points at the version that is still alive.
      const [row] = await storedRules();
      expect(row.definition.actionSecret?.secretVersionRef).toBe(versionRef(2));
    });

    // The repository's update used to be UPDATE + a separate read-back. A read failure
    // after the UPDATE committed took the handler's rejection path, which retires the
    // version the update installed — but the committed row now POINTS at that version,
    // so the live rule signed with a destroyed credential while the caller was told the
    // edit never happened. The write is one statement now: a rotation either commits
    // and answers 200, or rejects with nothing written.
    it("never destroys the version a committed rotation installed", async () => {
      const workflowId = await createRuleWithSecret();
      // Call 1 of the PATCH is the handler's own precondition read. Failing call 2
      // targets what follows the write: on the two-statement repository that is the
      // post-commit read-back; on the atomic one, no second read exists to fail.
      getWorkflowByIdFailure.calls = 0;
      getWorkflowByIdFailure.failOnCall = 2;

      const res = await request("PATCH", `${base}/${workflowId}`, {
        actionParams: { url: WEBHOOK_URL, secret: ROTATED_SECRET },
      });

      expect(res.status).toBe(200);
      const [row] = await storedRules();
      expect(row.definition.actionSecret?.secretVersionRef).toBe(versionRef(2));
      expect(secretStore.destroyVersion).not.toHaveBeenCalledWith({
        secretVersionRef: versionRef(2),
      });
      // Ordinary rotation cleanup still ran: only the superseded version was retired.
      expect(secretStore.destroyVersion).toHaveBeenCalledWith({ secretVersionRef: versionRef(1) });
    });

    // The destructive mistake in the other direction: retiring a version the rule still
    // points at would break every subsequent delivery.
    it("destroys nothing when the edit does not resend the secret", async () => {
      const workflowId = await createRuleWithSecret();

      const res = await request("PATCH", `${base}/${workflowId}`, { enabled: false });

      expect(res.status).toBe(200);
      expect(secretStore.destroyVersion).not.toHaveBeenCalled();
      const [row] = await storedRules();
      expect(row.definition.actionSecret?.secretVersionRef).toBe(versionRef(1));
    });

    // Once the row points at the new version the old one is unreferenced, so retiring it
    // must not be left behind whatever else the handler still has to do. Cancelling the
    // rule's open executions runs in the same request and can fail on its own.
    it("retires the superseded version even when a later step fails", async () => {
      const workflowId = await createRuleWithSecret();
      repoRejects.cancelOpenExecutionsForWorkflow = new Error("deadlock detected");

      const res = await request("PATCH", `${base}/${workflowId}`, {
        enabled: false,
        actionParams: { url: WEBHOOK_URL, secret: ROTATED_SECRET },
      });

      expect(res.status).toBe(500);
      expect(secretStore.destroyVersion).toHaveBeenCalledWith({ secretVersionRef: versionRef(1) });
    });

    it("retires the newly written version when the update rejects", async () => {
      const workflowId = await createRuleWithSecret();
      repoRejects.updateWorkflow = new Error("deadlock detected");

      const res = await request("PATCH", `${base}/${workflowId}`, {
        actionParams: { url: WEBHOOK_URL, secret: ROTATED_SECRET },
      });

      expect(res.status).toBe(500);
      // The rotation never landed, so it is the new version that has no reader — the row
      // still points at the first one, which must survive.
      expect(secretStore.destroyVersion).toHaveBeenCalledTimes(1);
      expect(secretStore.destroyVersion).toHaveBeenCalledWith({ secretVersionRef: versionRef(2) });
      const [row] = await storedRules();
      expect(row.definition.actionSecret?.secretVersionRef).toBe(versionRef(1));
    });

    // An edit that rewrites no secret has nothing unreferenced to clean up: `actionSecret`
    // is the reference the untouched row still points at.
    it("retires nothing when a secretless update rejects", async () => {
      const workflowId = await createRuleWithSecret();
      repoRejects.updateWorkflow = new Error("deadlock detected");

      const res = await request("PATCH", `${base}/${workflowId}`, { enabled: false });

      expect(res.status).toBe(500);
      expect(secretStore.destroyVersion).not.toHaveBeenCalled();
    });

    it("applies no part of an edit whose secret write fails", async () => {
      const workflowId = await createRuleWithSecret();
      secretStore.write.mockRejectedValue(
        new CredentialSecretStoreError("secret manager unavailable", "UPSTREAM_ERROR")
      );

      const res = await request("PATCH", `${base}/${workflowId}`, {
        actionParams: { url: "https://hooks.example.com/rotated", secret: ROTATED_SECRET },
      });

      expect(res.status).toBe(400);
      // Before the fix the new URL landed while the secret did not, leaving the rule
      // signing its new destination with the superseded key.
      const [row] = await storedRules();
      expect(row.definition.action.params.url).toBe(WEBHOOK_URL);
      expect(row.definition.actionSecret?.secretVersionRef).toBe(versionRef(1));
      expect(secretStore.destroyVersion).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("retires the rule's secret", async () => {
      const workflowId = await createRuleWithSecret();

      const res = await request("DELETE", `${base}/${workflowId}`);

      expect(res.status).toBe(200);
      expect(secretStore.destroyVersion).toHaveBeenCalledWith({ secretVersionRef: versionRef(1) });
    });

    // Retired before the next failure point on purpose: a retry can now finish a failed
    // delete's cleanup, but the secret's retirement should not have to depend on one.
    it("retires the secret even when execution cancellation fails", async () => {
      const workflowId = await createRuleWithSecret();
      repoRejects.cancelOpenExecutionsForWorkflow = new Error("deadlock detected");

      const res = await request("DELETE", `${base}/${workflowId}`);

      expect(res.status).toBe(500);
      expect(secretStore.destroyVersion).toHaveBeenCalledWith({ secretVersionRef: versionRef(1) });
    });

    // Cleanup is best effort by contract: the rule is already gone, so a backend failure
    // must not turn a successful delete into an error the caller retries.
    it("succeeds even when the backend refuses the destroy", async () => {
      const workflowId = await createRuleWithSecret();
      secretStore.destroyVersion.mockRejectedValue(new Error("permission denied"));

      const res = await request("DELETE", `${base}/${workflowId}`);

      expect(res.status).toBe(200);
    });

    // Execution withdrawal runs last, so its failure leaves the rule soft-deleted with
    // its executions still open. The retry used to 404 — the live read excluded the row
    // the first call soft-deleted — making the withdrawal permanently unreachable and
    // leaving a held execution in the approval queue of a rule that no longer exists.
    // Delete must be idempotent over its own partial failure: the retry finishes the job.
    it("lets a retry withdraw the executions a failed delete left open", async () => {
      const workflowId = await createRuleWithSecret();
      await createWorkflowExecutionsRepository(env as never).createExecution({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        workflowId,
        tokenId: TOKEN_ID,
        triggerType: "kyc_approved",
        actionType: "send_webhook",
        status: "awaiting_review",
        idempotencyKey: "kyc_approved:delete-retry",
        triggerPayload: { wallet: "holder" },
        maxAttempts: 5,
      });
      repoRejects.cancelOpenExecutionsForWorkflow = new Error("deadlock detected");
      expect((await request("DELETE", `${base}/${workflowId}`)).status).toBe(500);

      repoRejects.cancelOpenExecutionsForWorkflow = null;
      const retry = await request("DELETE", `${base}/${workflowId}`);

      expect(retry.status).toBe(200);
      const { data } = (await retry.json()) as { data: { cancelledExecutions: number } };
      expect(data.cancelledExecutions).toBe(1);
      const row = await getDb(env)
        .prepare("SELECT status, error FROM workflow_executions WHERE workflow_id = ?")
        .bind(workflowId)
        .first<{ status: string; error: string | null }>();
      expect(row?.status).toBe("cancelled");
      expect(row?.error).toBe("RULE_WITHDRAWN");
    });

    // Idempotence must not widen visibility: a rule some other tenant soft-deleted is
    // still a 404 here, and a workflow id that never existed stays one too.
    it("still 404s a delete of a workflow that never existed", async () => {
      const res = await request("DELETE", `${base}/wf_never_existed`);

      expect(res.status).toBe(404);
    });
  });
});
