import { hashString } from "@sdp/payments/hash";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DatabaseClient, getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError, internalError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { rootLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import * as credentialSecretStoreModule from "@/services/credential-secret-store";
import {
  type CredentialSecretStore,
  CredentialSecretStoreError,
} from "@/services/credential-secret-store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import internalCustody from "./index";

const ORGANIZATION_ID = "org_provider_credential_submit";
const PROJECT_ID = "prj_provider_credential_submit";
const USER_ID = "usr_provider_credential_submit";
const VALID_BODY = {
  provider: "privy",
  fields: {
    credentialLabel: "  Treasury Privy  ",
    scope: "project",
    appId: "  privy-app-1234  ",
    appSecret: " exact secret ",
  },
} as const;

function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createJwt(payload: ClerkJwtPayload): string {
  return `${encodeJwtPart({ alg: "RS256", typ: "JWT" })}.${encodeJwtPart(payload)}.signature`;
}

function testEncryptionKey(): string {
  return Buffer.alloc(32, 7).toString("base64");
}

function buildApp(options: { injectJwt?: boolean } = {}) {
  const token = createJwt({
    sub: "clerk_provider_credential_submit",
    org_id: "clerk_org_provider_credential_submit",
    org_role: "org:admin",
    email: "provider-credential-submit@example.com",
  });
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", kvStoreMiddleware());
  app.use("*", async (c, next) => {
    if (options.injectJwt !== false) {
      c.set("verifiedClerkJwt", {
        token,
        payload: {
          sub: "clerk_provider_credential_submit",
          org_id: "clerk_org_provider_credential_submit",
          org_role: "org:admin",
          email: "provider-credential-submit@example.com",
        },
      });
    }
    c.set("requestId", "req_provider_credential_submit");
    await next();
  });
  app.route("/internal/dashboard/custody", internalCustody);
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        {
          error: error.toResponse().error,
          meta: { requestId: c.get("requestId") },
        },
        error.statusCode as 400
      );
    }
    throw error;
  });

  return { app, token };
}

async function seedActor(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, ?, ?, 'individual', 'active')`
      )
      .bind(ORGANIZATION_ID, "Provider Credential Submit", "provider-credential-submit"),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, ?, 1, 'active')`
      )
      .bind(USER_ID, "provider-credential-submit@example.com"),
    db
      .prepare(
        `INSERT INTO auth_user_identities
           (id, provider, provider_user_id, user_id, email)
         VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind(
        "aui_provider_credential_submit",
        "clerk_provider_credential_submit",
        USER_ID,
        "provider-credential-submit@example.com"
      ),
    db
      .prepare(
        `INSERT INTO auth_organization_identities
           (id, provider, provider_org_id, organization_id, slug)
         VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind(
        "aoi_provider_credential_submit",
        "clerk_org_provider_credential_submit",
        ORGANIZATION_ID,
        "provider-credential-submit"
      ),
    db
      .prepare(
        `INSERT INTO organization_members
           (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'admin', 'active')`
      )
      .bind("mem_provider_credential_submit", ORGANIZATION_ID, USER_ID),
    db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
      )
      .bind(
        PROJECT_ID,
        ORGANIZATION_ID,
        "Provider Credential Submit",
        "provider-credential-submit",
        USER_ID
      ),
    db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, 'admin')`
      )
      .bind("pm_provider_credential_submit", PROJECT_ID, USER_ID),
  ]);
}

async function submit(
  app: Hono<{ Bindings: Env }>,
  token: string,
  options: {
    key?: string;
    projectId?: string;
    body?: unknown;
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Project-ID": options.projectId ?? PROJECT_ID,
  };
  if (options.key !== undefined) {
    headers["Idempotency-Key"] = options.key;
  }

  return app.request(
    "/internal/dashboard/custody/provider-credentials",
    {
      method: "POST",
      headers,
      body: JSON.stringify(options.body ?? VALID_BODY),
    },
    env
  );
}

async function replace(
  app: Hono<{ Bindings: Env }>,
  token: string,
  connectionId: string,
  options: {
    key?: string;
    projectId?: string;
    body?: unknown;
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Project-ID": options.projectId ?? PROJECT_ID,
  };
  if (options.key !== undefined) {
    headers["Idempotency-Key"] = options.key;
  }

  return app.request(
    `/internal/dashboard/custody/connections/${connectionId}/provider-credentials`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(options.body ?? VALID_BODY),
    },
    env
  );
}

async function getDomainCounts(): Promise<{
  credentials: number;
  connections: number;
  wallets: number;
}> {
  const counts = await getDb(env)
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM provider_credentials) AS credentials,
         (SELECT COUNT(*) FROM custody_connections) AS connections,
         (SELECT COUNT(*) FROM custody_wallets) AS wallets`
    )
    .first<{ credentials: number; connections: number; wallets: number }>();
  return counts ?? { credentials: 0, connections: 0, wallets: 0 };
}

type StoredConnection = {
  id: string;
  project_id: string;
  provider: string;
  provider_credential_id: string;
  status: string;
  setup_metadata: Record<string, unknown>;
  last_check_status: string | null;
  last_check_at: string | null;
  last_check_failure_code: string | null;
};

async function getConnectionForCredential(credentialId: string): Promise<StoredConnection> {
  const connection = await getDb(env)
    .prepare(
      `SELECT id, project_id, provider, provider_credential_id, status,
              setup_metadata, last_check_status, last_check_at, last_check_failure_code
       FROM custody_connections
       WHERE provider_credential_id = ?`
    )
    .bind(credentialId)
    .first<StoredConnection>();
  if (!connection) {
    throw new Error(`Connection not found for credential ${credentialId}`);
  }
  return connection;
}

type InitialSetupIds = {
  credentialId: string;
  connectionId: string;
};

type RejectedReplacementCase = {
  label: string;
  key: string;
  arrange: (db: DatabaseClient, ids: InitialSetupIds) => Promise<void>;
};

async function markInitialValidationFailed(
  db: DatabaseClient,
  { credentialId, connectionId }: InitialSetupIds
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE provider_credentials
         SET status = 'failed_validation',
             last_failed_at = sdp_iso_now(),
             last_failure_code = 'invalid_credentials'
         WHERE id = ?`
      )
      .bind(credentialId),
    db
      .prepare(
        `UPDATE custody_connections
         SET status = 'failed',
             last_check_status = 'failed',
             last_check_at = sdp_iso_now(),
             last_check_failure_code = 'invalid_credentials'
         WHERE id = ?`
      )
      .bind(connectionId),
  ]);
}

describe("POST /internal/dashboard/custody/provider-credentials", () => {
  const original = {
    deploymentMode: env.SDP_DEPLOYMENT_MODE,
    backend: env.CREDENTIAL_SECRET_STORE_BACKEND,
    encryptionKey: env.CUSTODY_ENCRYPTION_KEY,
    provisioningFlag: env.PRIVY_BYOK_ENABLED,
    fingerprintPepper: env.CREDENTIAL_FINGERPRINT_PEPPER,
  };

  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedActor();
    env.SDP_DEPLOYMENT_MODE = "managed";
    env.CREDENTIAL_SECRET_STORE_BACKEND = "encrypted_db";
    env.CUSTODY_ENCRYPTION_KEY = testEncryptionKey();
    env.PRIVY_BYOK_ENABLED = "true";
    env.CREDENTIAL_FINGERPRINT_PEPPER = "test-credential-fingerprint-pepper-for-unit-tests";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    env.SDP_DEPLOYMENT_MODE = original.deploymentMode;
    env.CREDENTIAL_SECRET_STORE_BACKEND = original.backend;
    env.CUSTODY_ENCRYPTION_KEY = original.encryptionKey;
    env.PRIVY_BYOK_ENABLED = original.provisioningFlag;
    env.CREDENTIAL_FINGERPRINT_PEPPER = original.fingerprintPepper;
    await clearKVStores(env);
  });

  it("stores one pending credential and one pending project connection", async () => {
    const { app, token } = buildApp();
    const response = await submit(app, token, {
      key: "submit-privy-credentials-1",
      body: { ...VALID_BODY, walletLabel: "  Treasury Wallet  " },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Key")).toBe("submit-privy-credentials-1");
    const body = (await response.json()) as {
      data: {
        providerCredential: { id: string };
        connectionId: string;
      };
      meta: { requestId: string; timestamp: string };
    };
    expect(body).toEqual({
      data: {
        connectionId: expect.stringMatching(/^cconn_/),
        providerCredential: {
          id: expect.stringMatching(/^pcred_/),
          provider: "privy",
          label: "Treasury Privy",
          scope: "project",
          projectId: PROJECT_ID,
          status: "pending",
          createdAt: expect.any(String),
          displayMetadata: { appIdSuffix: "1234" },
        },
      },
      meta: {
        requestId: "req_provider_credential_submit",
        timestamp: expect.any(String),
      },
    });
    expect(JSON.stringify(body)).not.toContain("privy-app-1234");
    expect(JSON.stringify(body)).not.toContain("exact secret");

    expect(await getDomainCounts()).toEqual({
      credentials: 1,
      connections: 1,
      wallets: 0,
    });
    const connection = await getConnectionForCredential(body.data.providerCredential.id);
    expect(connection.id).toBe(body.data.connectionId);
    expect(connection).toMatchObject({
      project_id: PROJECT_ID,
      provider: "privy",
      provider_credential_id: body.data.providerCredential.id,
      status: "pending",
      setup_metadata: { pendingWalletLabel: "Treasury Wallet" },
    });
    const defaults = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM custody_scope_defaults")
      .first<{ count: number }>();
    expect(defaults?.count).toBe(0);
  });

  it("keeps a committed submission replayable when its audit outcome cannot be persisted", async () => {
    const completeCritical = vi
      .spyOn(AuditService.prototype, "completeCritical")
      .mockResolvedValue(false);
    const { app, token } = buildApp();

    const first = await submit(app, token, { key: "submission-audit-outcome-failure" });
    const replay = await submit(app, token, { key: "submission-audit-outcome-failure" });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    const firstBody = (await first.json()) as { data: unknown };
    const replayBody = (await replay.json()) as { data: unknown };
    expect(replayBody.data).toEqual(firstBody.data);
    expect(completeCritical).toHaveBeenCalledOnce();
    expect(await getDomainCounts()).toEqual({ credentials: 1, connections: 1, wallets: 0 });

    const audits = await getDb(env)
      .prepare(
        `SELECT action, resource_type
         FROM audit_logs
         ORDER BY ledger_sequence`
      )
      .all<{ action: string; resource_type: string }>();
    expect(audits.results).toEqual([{ action: "maintenance", resource_type: "audit_ledger" }]);
  });

  it("does not write a secret when the submission audit intent cannot be persisted", async () => {
    vi.spyOn(AuditService.prototype, "beginCritical").mockRejectedValue(internalError());
    const factory = vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore");
    const { app, token } = buildApp();

    const response = await submit(app, token, { key: "submission-audit-intent-failure" });

    expect(response.status).toBe(500);
    expect(factory).not.toHaveBeenCalled();
    expect(await getDomainCounts()).toEqual({ credentials: 0, connections: 0, wallets: 0 });
  });

  it("requires an idempotency key after auth, project, and body validation", async () => {
    const { app, token } = buildApp();
    const response = await submit(app, token);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "Idempotency-Key is required",
      },
    });
    expect(await getDomainCounts()).toEqual({
      credentials: 0,
      connections: 0,
      wallets: 0,
    });
  });

  it("requires dashboard authentication", async () => {
    const { app } = buildApp({ injectJwt: false });
    const response = await app.request(
      "/internal/dashboard/custody/provider-credentials",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "missing-auth",
          "X-Project-ID": PROJECT_ID,
        },
        body: JSON.stringify(VALID_BODY),
      },
      env
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("accepts an organization admin dashboard session", async () => {
    const sessionId = "ses_provider_credential_submit";
    await getDb(env)
      .prepare(
        `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
         VALUES (?, ?, ?, 'session', ?)`
      )
      .bind(sessionId, USER_ID, ORGANIZATION_ID, "2999-01-01T00:00:00.000Z")
      .run();
    const { app } = buildApp({ injectJwt: false });

    const response = await app.request(
      "/internal/dashboard/custody/provider-credentials",
      {
        method: "POST",
        headers: {
          Cookie: `sdp_session=${sessionId}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "session-submit",
          "X-Project-ID": PROJECT_ID,
        },
        body: JSON.stringify(VALID_BODY),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      data: { connectionId: expect.stringMatching(/^cconn_/) },
    });
  });

  it("rejects API-key authentication even with custody admin permission", async () => {
    const rawKey = "sk_test_internal_credential_admin";
    const keyHash = await hashString(rawKey, env.API_KEY_PEPPER);
    await seedCachedApiKey(env, keyHash, {
      id: "key_internal_credential_admin",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      role: "api_admin",
      permissions: ["*"],
      environment: "sandbox",
      rateLimitTier: "standard",
      allowedIps: null,
      signingWalletId: null,
      status: "active",
      expiresAt: null,
    });
    const { app } = buildApp({ injectJwt: false });

    const response = await submit(app, rawKey, {
      key: "api-key-auth-rejected",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: "Credential administration does not accept API keys",
      },
    });
  });

  it("requires an accessible X-Project-ID before body handling", async () => {
    const { app, token } = buildApp();
    const response = await app.request(
      "/internal/dashboard/custody/provider-credentials",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "missing-project",
        },
        body: JSON.stringify(VALID_BODY),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "Project scope is required. Provide a x-project-id header.",
      },
    });
  });

  it.each([
    ["unknown provider", { ...VALID_BODY, provider: "turnkey" }],
    [
      "organization scope",
      { ...VALID_BODY, fields: { ...VALID_BODY.fields, scope: "organization" } },
    ],
    ["extra envelope field", { ...VALID_BODY, extra: true }],
    ["extra credential field", { ...VALID_BODY, fields: { ...VALID_BODY.fields, extra: true } }],
    [
      "walletLabel",
      {
        ...VALID_BODY,
        fields: { ...VALID_BODY.fields, walletLabel: "Must not be accepted" },
      },
    ],
    ["blank wallet label", { ...VALID_BODY, walletLabel: "   " }],
    ["long wallet label", { ...VALID_BODY, walletLabel: "x".repeat(101) }],
    ["blank normalized app ID", { ...VALID_BODY, fields: { ...VALID_BODY.fields, appId: "   " } }],
    [
      "blank normalized label",
      {
        ...VALID_BODY,
        fields: { ...VALID_BODY.fields, credentialLabel: "   " },
      },
    ],
    ["empty opaque secret", { ...VALID_BODY, fields: { ...VALID_BODY.fields, appSecret: "" } }],
  ])("rejects %s without persistence", async (_name, body) => {
    const { app, token } = buildApp();
    const response = await submit(app, token, {
      key: "strict-contract-key",
      body,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "BAD_REQUEST", message: "Invalid request body" },
    });
    expect(await getDomainCounts()).toEqual({
      credentials: 0,
      connections: 0,
      wallets: 0,
    });
  });

  it("replays the committed result before current gates and keeps the secret exact", async () => {
    const { app, token } = buildApp();
    const first = await submit(app, token, {
      key: "replay-before-gates",
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      data: {
        providerCredential: { id: string };
      };
    };

    const stored = await getDb(env)
      .prepare(
        `SELECT storage_backend, secret_ref, secret_version_ref,
                encrypted_secret_payload, idempotency_key,
                idempotency_fingerprint
         FROM provider_credentials
         WHERE id = ?`
      )
      .bind(firstBody.data.providerCredential.id)
      .first<{
        storage_backend: "encrypted_db";
        secret_ref: string | null;
        secret_version_ref: string | null;
        encrypted_secret_payload: string;
        idempotency_key: string;
        idempotency_fingerprint: string;
      }>();
    expect(stored?.idempotency_key).toBe("replay-before-gates");
    expect(stored?.idempotency_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.idempotency_fingerprint).not.toContain("privy-app-1234");
    expect(stored?.idempotency_fingerprint).not.toContain("exact secret");

    const secretStore = credentialSecretStoreModule.createCredentialSecretStore(env);
    await expect(
      secretStore.read({
        orgId: ORGANIZATION_ID,
        stored: {
          storageBackend: stored?.storage_backend ?? "encrypted_db",
          secretRef: stored?.secret_ref ?? undefined,
          secretVersionRef: stored?.secret_version_ref ?? undefined,
          encryptedSecretPayload: stored?.encrypted_secret_payload ?? undefined,
        },
      })
    ).resolves.toEqual({
      appId: "privy-app-1234",
      appSecret: " exact secret ",
    });

    env.PRIVY_BYOK_ENABLED = undefined;
    await getDb(env)
      .prepare(
        `UPDATE organizations
         SET settings = ?
         WHERE id = ?`
      )
      .bind(
        JSON.stringify({
          providerOverrides: { custody: { privy: false } },
        }),
        ORGANIZATION_ID
      )
      .run();

    const replay = await submit(app, token, {
      key: "replay-before-gates",
    });
    expect(replay.status).toBe(201);
    const replayBody = (await replay.json()) as typeof firstBody;
    expect(replayBody.data).toEqual(firstBody.data);

    const deniedNewIntent = await submit(app, token, {
      key: "new-intent-after-gates",
    });
    expect(deniedNewIntent.status).toBe(403);
    expect(await deniedNewIntent.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: "Stored credential provisioning is disabled for this provider",
      },
    });
    expect(await getDomainCounts()).toEqual({
      credentials: 1,
      connections: 1,
      wallets: 0,
    });

    const audits = await getDb(env)
      .prepare(
        `SELECT action, resource_id
         FROM audit_logs
         WHERE resource_type = 'provider_credential'
         ORDER BY created_at`
      )
      .all<{ action: string; resource_id: string | null }>();
    expect(audits.results).toEqual([
      {
        action: "submit",
        resource_id: firstBody.data.providerCredential.id,
      },
    ]);
  });

  it.each([
    [
      "credential secret",
      {
        ...VALID_BODY,
        fields: {
          ...VALID_BODY.fields,
          appSecret: "different secret",
        },
      },
    ],
    ["wallet label", { ...VALID_BODY, walletLabel: "Different wallet" }],
  ])("rejects same-key %s reuse before another secret write", async (_field, changedBody) => {
    const { app, token } = buildApp();
    expect(
      (
        await submit(app, token, {
          key: "same-key-different-payload",
        })
      ).status
    ).toBe(201);

    const response = await submit(app, token, {
      key: "same-key-different-payload",
      body: changedBody,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        message: "Idempotency key already used with different request payload",
      },
    });
    expect(await getDomainCounts()).toEqual({
      credentials: 1,
      connections: 1,
      wallets: 0,
    });
    const failureAudit = await getDb(env)
      .prepare(
        `SELECT resource_id
         FROM audit_logs
         WHERE resource_type = 'provider_credential'
           AND action = 'submit_failed'`
      )
      .first<{ resource_id: string | null }>();
    expect(failureAudit?.resource_id).toBeNull();
  });

  it("denies an unseen key before constructing the secret store when the flag is off", async () => {
    env.PRIVY_BYOK_ENABLED = undefined;
    const factory = vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore");
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key: "disabled-new-intent",
    });

    expect(response.status).toBe(403);
    expect(factory).not.toHaveBeenCalled();
    expect(await getDomainCounts()).toEqual({
      credentials: 0,
      connections: 0,
      wallets: 0,
    });
    const auditCount = await getDb(env)
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_logs
         WHERE resource_type = 'provider_credential'`
      )
      .first<{ count: number }>();
    expect(auditCount?.count).toBe(0);
  });

  it("keeps stored Connection setup disabled for self-hosted deployments until HOO-771", async () => {
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    const factory = vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore");
    const { app, token } = buildApp();

    const response = await submit(app, token, { key: "self-hosted-before-runtime-bootstrap" });

    expect(response.status).toBe(403);
    expect(factory).not.toHaveBeenCalled();
    expect(await getDomainCounts()).toEqual({ credentials: 0, connections: 0, wallets: 0 });
  });

  it("replaces credentials only on the exact eligible failed connection", async () => {
    const { app, token } = buildApp();
    const first = await submit(app, token, {
      key: "replacement-v1",
      body: { ...VALID_BODY, walletLabel: "First wallet" },
    });
    const firstBody = (await first.json()) as {
      data: {
        providerCredential: { id: string };
      };
    };
    const firstCredentialId = firstBody.data.providerCredential.id;
    const connectionId = (await getConnectionForCredential(firstCredentialId)).id;
    await markInitialValidationFailed(getDb(env), {
      credentialId: firstCredentialId,
      connectionId,
    });

    const replacement = await replace(app, token, connectionId, {
      key: "replacement-v2",
      body: {
        provider: "privy",
        walletLabel: "Corrected wallet",
        fields: {
          credentialLabel: "Corrected project credential",
          scope: "project",
          appId: "corrected-app-5678",
          appSecret: "corrected secret",
        },
      },
    });
    expect(replacement.status).toBe(201);
    const replacementBody = (await replacement.json()) as {
      data: {
        providerCredential: {
          id: string;
          scope: string;
          projectId: string | null;
        };
        connectionId: string;
      };
    };
    expect(replacementBody.data.providerCredential).toMatchObject({
      scope: "project",
      projectId: PROJECT_ID,
    });
    expect(replacementBody.data.connectionId).toBe(connectionId);
    expect(
      await getConnectionForCredential(replacementBody.data.providerCredential.id)
    ).toMatchObject({
      id: connectionId,
      provider_credential_id: replacementBody.data.providerCredential.id,
      status: "pending",
      setup_metadata: { pendingWalletLabel: "Corrected wallet" },
      last_check_status: null,
      last_check_at: null,
      last_check_failure_code: null,
    });

    const credentials = await getDb(env)
      .prepare(
        `SELECT id, status, credential_version,
                rotated_from_provider_credential_id
         FROM provider_credentials
         ORDER BY credential_version`
      )
      .all<{
        id: string;
        status: string;
        credential_version: number;
        rotated_from_provider_credential_id: string | null;
      }>();
    expect(credentials.results).toEqual([
      {
        id: firstCredentialId,
        status: "failed_validation",
        credential_version: 1,
        rotated_from_provider_credential_id: null,
      },
      {
        id: replacementBody.data.providerCredential.id,
        status: "pending",
        credential_version: 2,
        rotated_from_provider_credential_id: firstCredentialId,
      },
    ]);
    expect(await getDomainCounts()).toEqual({
      credentials: 2,
      connections: 1,
      wallets: 0,
    });

    const oldReplay = await submit(app, token, {
      key: "replacement-v1",
      body: { ...VALID_BODY, walletLabel: "First wallet" },
    });
    expect(oldReplay.status).toBe(201);
    expect(await oldReplay.json()).toEqual({
      data: {
        connectionId,
        providerCredential: expect.objectContaining({
          id: firstCredentialId,
          status: "failed_validation",
        }),
      },
      meta: {
        requestId: "req_provider_credential_submit",
        timestamp: expect.any(String),
      },
    });
  });

  it("clears the pending wallet label when replacement omits walletLabel", async () => {
    const { app, token } = buildApp();
    const first = await submit(app, token, {
      key: "replacement-clear-label-v1",
      body: { ...VALID_BODY, walletLabel: "First wallet" },
    });
    const firstBody = (await first.json()) as {
      data: { providerCredential: { id: string } };
    };
    const firstCredentialId = firstBody.data.providerCredential.id;
    const connectionId = (await getConnectionForCredential(firstCredentialId)).id;
    await markInitialValidationFailed(getDb(env), {
      credentialId: firstCredentialId,
      connectionId,
    });

    const replacement = await replace(app, token, connectionId, {
      key: "replacement-clear-label-v2",
      body: {
        ...VALID_BODY,
        fields: {
          ...VALID_BODY.fields,
          appId: "replacement-app-id",
          appSecret: "replacement secret",
        },
      },
    });
    expect(replacement.status).toBe(201);
    const replacementBody = (await replacement.json()) as {
      data: { providerCredential: { id: string } };
    };

    const connection = await getConnectionForCredential(replacementBody.data.providerCredential.id);
    expect(connection.id).toBe(connectionId);
    expect(connection.setup_metadata).toEqual({});
  });

  it("binds replacement idempotency to the exact Connection", async () => {
    const { app, token } = buildApp();
    const first = await submit(app, token, { key: "exact-idempotency-first" });
    const firstBody = (await first.json()) as {
      data: { providerCredential: { id: string }; connectionId: string };
    };
    await markInitialValidationFailed(getDb(env), {
      credentialId: firstBody.data.providerCredential.id,
      connectionId: firstBody.data.connectionId,
    });

    const second = await submit(app, token, { key: "exact-idempotency-second" });
    const secondBody = (await second.json()) as {
      data: { providerCredential: { id: string }; connectionId: string };
    };
    await markInitialValidationFailed(getDb(env), {
      credentialId: secondBody.data.providerCredential.id,
      connectionId: secondBody.data.connectionId,
    });

    const replaced = await replace(app, token, firstBody.data.connectionId, {
      key: "exact-idempotency-replacement",
    });
    expect(replaced.status).toBe(201);

    const wrongTargetReplay = await replace(app, token, secondBody.data.connectionId, {
      key: "exact-idempotency-replacement",
    });
    expect(wrongTargetReplay.status).toBe(409);
    expect(await wrongTargetReplay.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        message: "Idempotency key already used with different request payload",
      },
    });
  });

  it("fails closed when exact replacement targets a non-replaceable Connection", async () => {
    const { app, token } = buildApp();
    const initial = await submit(app, token, { key: "exact-non-replaceable-initial" });
    const initialBody = (await initial.json()) as { data: { connectionId: string } };

    const response = await replace(app, token, initialBody.data.connectionId, {
      key: "exact-non-replaceable-attempt",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        message: "Custody Connection cannot accept replacement credentials",
      },
    });
    expect(await getDomainCounts()).toEqual({ credentials: 1, connections: 1, wallets: 0 });
  });

  it("does not expose a Connection from another Project during exact replacement", async () => {
    const otherProjectId = "prj_provider_credential_submit_exact_other";
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO projects
             (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Other exact project', 'other-exact-project', 'sandbox', 'active', ?)`
        )
        .bind(otherProjectId, ORGANIZATION_ID, USER_ID),
      getDb(env)
        .prepare(
          `INSERT INTO project_members (id, project_id, user_id, role)
           VALUES ('pm_provider_credential_submit_exact_other', ?, ?, 'admin')`
        )
        .bind(otherProjectId, USER_ID),
    ]);
    const { app, token } = buildApp();
    const other = await submit(app, token, {
      key: "exact-other-project-initial",
      projectId: otherProjectId,
    });
    const otherBody = (await other.json()) as {
      data: { providerCredential: { id: string }; connectionId: string };
    };
    await markInitialValidationFailed(getDb(env), {
      credentialId: otherBody.data.providerCredential.id,
      connectionId: otherBody.data.connectionId,
    });

    const response = await replace(app, token, otherBody.data.connectionId, {
      key: "exact-other-project-replacement",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Custody Connection not found" },
    });
    expect(await getDomainCounts()).toEqual({ credentials: 1, connections: 1, wallets: 0 });
  });

  it.each([
    {
      label: "a pending connection",
      key: "pending",
      arrange: () => Promise.resolve(),
    },
    {
      label: "a checking connection",
      key: "checking",
      arrange: async (db, { connectionId }) => {
        await db
          .prepare(
            `UPDATE custody_connections
             SET status = 'checking',
                 last_check_status = 'running',
                 last_check_at = sdp_iso_now()
             WHERE id = ?`
          )
          .bind(connectionId)
          .run();
      },
    },
  ] satisfies RejectedReplacementCase[])(
    "rejects a new credential when the project already has $label",
    async ({ key, arrange }) => {
      const { app, token } = buildApp();
      const initial = await submit(app, token, {
        key: `blocked-${key}-initial`,
      });
      expect(initial.status).toBe(201);
      const initialBody = (await initial.json()) as {
        data: {
          providerCredential: { id: string };
        };
      };
      const db = getDb(env);
      const initialConnection = await getConnectionForCredential(
        initialBody.data.providerCredential.id
      );
      await arrange(db, {
        credentialId: initialBody.data.providerCredential.id,
        connectionId: initialConnection.id,
      });

      const readSafeSetupState = async () => {
        const [credentials, connections] = await Promise.all([
          db
            .prepare(
              `SELECT id, project_id, status, credential_version,
                      rotated_from_provider_credential_id, idempotency_key
               FROM provider_credentials
               ORDER BY id`
            )
            .all<Record<string, unknown>>(),
          db
            .prepare(
              `SELECT id, project_id, status, provider_credential_id,
                      default_custody_wallet_id, setup_metadata,
                      last_check_status, last_check_at, last_check_failure_code,
                      activated_at
               FROM custody_connections
               ORDER BY id`
            )
            .all<Record<string, unknown>>(),
        ]);
        return {
          credentials: credentials.results,
          connections: connections.results,
        };
      };

      const stateBefore = await readSafeSetupState();
      const countsBefore = await getDomainCounts();
      const factory = vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore");
      const newKey = `blocked-${key}-new`;

      const response = await submit(app, token, { key: newKey });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: "CONFLICT",
          message: "A Privy custody installation is already in progress for this project",
          details: { reason: "unfinished_installation_exists" },
        },
        meta: { requestId: "req_provider_credential_submit" },
      });
      expect(factory).not.toHaveBeenCalled();
      expect(await readSafeSetupState()).toEqual(stateBefore);
      expect(await getDomainCounts()).toEqual(countsBefore);
      const newIntentCount = await db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM provider_credentials
           WHERE idempotency_key = ?`
        )
        .bind(newKey)
        .first<{ count: number }>();
      expect(newIntentCount?.count).toBe(0);
    }
  );

  it.each(["active", "failed"] as const)(
    "creates a fresh Connection beside %s history instead of implicitly replacing it",
    async (historyStatus) => {
      const { app, token } = buildApp();
      const initial = await submit(app, token, { key: `history-${historyStatus}-initial` });
      const initialBody = (await initial.json()) as {
        data: { providerCredential: { id: string }; connectionId: string };
      };
      const ids = {
        credentialId: initialBody.data.providerCredential.id,
        connectionId: initialBody.data.connectionId,
      };
      if (historyStatus === "failed") {
        await markInitialValidationFailed(getDb(env), ids);
      } else {
        const historyWalletId = "cwlt_active_history";
        await getDb(env).batch([
          getDb(env)
            .prepare(
              `INSERT INTO custody_wallets (
               id, custody_connection_id, wallet_id, public_key, status
             ) VALUES (?, ?, 'privy_active_history', 'active_history_public_key', 'active')`
            )
            .bind(historyWalletId, ids.connectionId),
          getDb(env)
            .prepare(
              `UPDATE provider_credentials
               SET status = 'active', last_validated_at = sdp_iso_now()
               WHERE id = ?`
            )
            .bind(ids.credentialId),
          getDb(env)
            .prepare(
              `UPDATE custody_connections
               SET status = 'active', last_check_status = 'success',
                   last_check_at = sdp_iso_now(), activated_at = sdp_iso_now(),
                   default_custody_wallet_id = ?,
                   provider_account_fingerprint = 'sha256:active-history'
               WHERE id = ?`
            )
            .bind(historyWalletId, ids.connectionId),
        ]);
      }

      const fresh = await submit(app, token, { key: `history-${historyStatus}-fresh` });
      expect(fresh.status).toBe(201);
      const freshBody = (await fresh.json()) as {
        data: { providerCredential: { id: string }; connectionId: string };
      };
      expect(freshBody.data.connectionId).not.toBe(ids.connectionId);
      expect(await getDomainCounts()).toEqual({
        credentials: 2,
        connections: 2,
        wallets: historyStatus === "active" ? 1 : 0,
      });
    }
  );

  it("reinstalls as a new root and preserves deactivated lineage replay", async () => {
    const { app, token } = buildApp();
    const first = await submit(app, token, {
      key: "deactivated-lineage-v1",
    });
    const firstBody = (await first.json()) as {
      data: {
        providerCredential: { id: string };
      };
    };
    const firstConnection = await getConnectionForCredential(firstBody.data.providerCredential.id);

    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'deactivated',
             deactivated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(firstConnection.id)
      .run();

    const reinstall = await submit(app, token, {
      key: "deactivated-lineage-reinstall",
    });
    expect(reinstall.status).toBe(201);
    const reinstallBody = (await reinstall.json()) as {
      data: {
        providerCredential: { id: string };
      };
    };
    const reinstallConnection = await getConnectionForCredential(
      reinstallBody.data.providerCredential.id
    );
    expect(reinstallBody.data.providerCredential.id).not.toBe(firstBody.data.providerCredential.id);
    expect(reinstallConnection.id).not.toBe(firstConnection.id);

    const roots = await getDb(env)
      .prepare(
        `SELECT id, credential_version, rotated_from_provider_credential_id
         FROM provider_credentials
         ORDER BY created_at, id`
      )
      .all<{
        id: string;
        credential_version: number;
        rotated_from_provider_credential_id: string | null;
      }>();
    expect(roots.results).toEqual([
      {
        id: firstBody.data.providerCredential.id,
        credential_version: 1,
        rotated_from_provider_credential_id: null,
      },
      {
        id: reinstallBody.data.providerCredential.id,
        credential_version: 1,
        rotated_from_provider_credential_id: null,
      },
    ]);

    const oldReplay = await submit(app, token, {
      key: "deactivated-lineage-v1",
    });
    expect(oldReplay.status).toBe(201);
    expect(await oldReplay.json()).toEqual({
      data: {
        connectionId: firstConnection.id,
        providerCredential: expect.objectContaining({
          id: firstBody.data.providerCredential.id,
        }),
      },
      meta: {
        requestId: "req_provider_credential_submit",
        timestamp: expect.any(String),
      },
    });
    expect(await getDomainCounts()).toEqual({
      credentials: 2,
      connections: 2,
      wallets: 0,
    });
  });

  it("admits a pending Connection beside the selected active Project Config", async () => {
    const db = getDb(env);
    const configId = "cust_active_exact_project";
    await db.batch([
      db
        .prepare(
          `INSERT INTO custody_configs (
             id, organization_id, project_id, provider, config_encrypted,
             encryption_version, default_wallet_id, status
           ) VALUES (?, ?, ?, 'privy', 'legacy', 'test', 'legacy-wallet', 'active')`
        )
        .bind(configId, ORGANIZATION_ID, PROJECT_ID),
      db
        .prepare(
          `INSERT INTO custody_wallets (
             id, custody_config_id, wallet_id, public_key, label, status
           ) VALUES (
             'cwal_active_exact_project', ?, 'legacy-wallet',
             'legacy-public-key', 'Legacy wallet', 'active'
           )`
        )
        .bind(configId),
      db
        .prepare(
          `INSERT INTO custody_scope_defaults (
             id, organization_id, project_id, default_custody_config_id
           ) VALUES ('csd_active_exact_project', ?, ?, ?)`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID, configId),
    ]);
    const readLegacyState = () =>
      db
        .prepare(
          `SELECT c.id AS config_id, c.config_encrypted, c.default_wallet_id,
                  c.status AS config_status, w.id AS custody_wallet_id,
                  w.wallet_id, w.public_key, w.status AS wallet_status,
                  w.custody_config_id, w.custody_connection_id,
                  d.default_custody_config_id, d.default_custody_connection_id
           FROM custody_configs c
           JOIN custody_wallets w ON w.custody_config_id = c.id
           JOIN custody_scope_defaults d
             ON d.organization_id = c.organization_id AND d.project_id = c.project_id
           WHERE c.id = ?`
        )
        .bind(configId)
        .first();
    const legacyBefore = await readLegacyState();
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key: "legacy-active-coexistence",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: { providerCredential: { id: string } };
    };
    expect(body.data.providerCredential).toMatchObject({
      provider: "privy",
      projectId: PROJECT_ID,
      status: "pending",
    });
    expect(await getConnectionForCredential(body.data.providerCredential.id)).toMatchObject({
      project_id: PROJECT_ID,
      provider: "privy",
      status: "pending",
    });
    expect(await getDomainCounts()).toEqual({
      credentials: 1,
      connections: 1,
      wallets: 1,
    });
    expect(await readLegacyState()).toEqual(legacyBefore);
  });

  it("allows an inactive exact-project config and active organization fallback", async () => {
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs (
             id, organization_id, project_id, provider, config_encrypted,
             encryption_version, status
           ) VALUES (?, ?, ?, 'privy', 'legacy', 'test', 'inactive')`
        )
        .bind("cust_inactive_exact_project", ORGANIZATION_ID, PROJECT_ID),
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs (
             id, organization_id, project_id, provider, config_encrypted,
             encryption_version, status
           ) VALUES (?, ?, NULL, 'privy', 'legacy', 'test', 'active')`
        )
        .bind("cust_active_org_fallback", ORGANIZATION_ID),
    ]);
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key: "legacy-nonblocking",
    });
    expect(response.status).toBe(201);
    expect(await getDomainCounts()).toEqual({
      credentials: 1,
      connections: 1,
      wallets: 0,
    });
    const legacy = await getDb(env)
      .prepare(
        `SELECT id, status
         FROM custody_configs
         ORDER BY id`
      )
      .all<{ id: string; status: string }>();
    expect(legacy.results).toEqual([
      { id: "cust_active_org_fallback", status: "active" },
      { id: "cust_inactive_exact_project", status: "inactive" },
    ]);
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
  ] as const)(
    "fails closed before secret storage when CREDENTIAL_FINGERPRINT_PEPPER is %s",
    async (_case, value) => {
      env.CREDENTIAL_FINGERPRINT_PEPPER = value;
      const factory = vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore");
      const { app, token } = buildApp();

      const response = await submit(app, token, {
        key: "missing-pepper",
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: { code: "INTERNAL_ERROR" },
      });
      expect(factory).not.toHaveBeenCalled();
      expect(await getDomainCounts()).toEqual({
        credentials: 0,
        connections: 0,
        wallets: 0,
      });
    }
  );

  it("maps an upstream secret-store failure to a safe 503 and orphan alert", async () => {
    const store: CredentialSecretStore = {
      storageBackend: "gcp_secret_manager",
      write: vi
        .fn()
        .mockRejectedValue(new CredentialSecretStoreError("raw upstream detail", "UPSTREAM_ERROR")),
      read: vi.fn(),
      destroyVersion: vi.fn(),
    };
    vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore").mockReturnValue(store);
    const consoleError = vi.spyOn(rootLogger, "error").mockImplementation(() => undefined);
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key: "upstream-secret-failure",
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Credential storage is temporarily unavailable",
      },
    });
    expect(JSON.stringify(body)).not.toContain("raw upstream detail");
    expect(await getDomainCounts()).toEqual({
      credentials: 0,
      connections: 0,
      wallets: 0,
    });
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "privy",
        storageBackend: "gcp_secret_manager",
        requestId: "req_provider_credential_submit",
        reason: "secret_write_outcome_unknown",
      }),
      "provider_credential_orphan_risk"
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("raw upstream detail");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("exact secret");
    const criticalOutcomes = await getDb(env)
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_logs
         WHERE metadata::jsonb ->> 'auditPhase' = 'outcome'`
      )
      .first<{ count: number }>();
    expect(criticalOutcomes?.count).toBe(0);
  });

  it("destroys only the exact GCP version after a database rollback", async () => {
    const destroyVersion = vi.fn().mockResolvedValue(undefined);
    const store: CredentialSecretStore = {
      storageBackend: "gcp_secret_manager",
      write: vi.fn().mockResolvedValue({
        storageBackend: "gcp_secret_manager",
        // Deliberately omit secretRef so the domain insert violates its
        // storage-location check after a successful external version write.
        secretVersionRef: "projects/sdp-test/secrets/pcred-test/versions/7",
      }),
      read: vi.fn(),
      destroyVersion,
    };
    vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore").mockReturnValue(store);
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key: "gcp-db-rollback",
    });

    expect(response.status).toBe(500);
    expect(destroyVersion).toHaveBeenCalledOnce();
    expect(destroyVersion).toHaveBeenCalledWith({
      secretVersionRef: "projects/sdp-test/secrets/pcred-test/versions/7",
    });
    expect(await getDomainCounts()).toEqual({
      credentials: 0,
      connections: 0,
      wallets: 0,
    });
  });

  it("reconciles a committed row before cleaning up after a lost COMMIT response", async () => {
    const destroyVersion = vi.fn().mockResolvedValue(undefined);
    const store: CredentialSecretStore = {
      storageBackend: "gcp_secret_manager",
      write: vi.fn().mockResolvedValue({
        storageBackend: "gcp_secret_manager",
        secretRef: "projects/sdp-test/secrets/pcred-commit-ambiguity",
        secretVersionRef: "projects/sdp-test/secrets/pcred-commit-ambiguity/versions/9",
      }),
      read: vi.fn(),
      destroyVersion,
    };
    vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore").mockReturnValue(store);

    const db = getDb(env);
    const runTransaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(async (callback) => {
      await runTransaction(callback);
      throw new Error("simulated lost COMMIT response");
    });
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key: "gcp-commit-ambiguity",
    });

    expect(response.status).toBe(201);
    expect(destroyVersion).not.toHaveBeenCalled();
    expect(await getDomainCounts()).toEqual({
      credentials: 1,
      connections: 1,
      wallets: 0,
    });
    const auditCount = await getDb(env)
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_logs
         WHERE resource_type = 'provider_credential'
           AND action = 'submit'`
      )
      .first<{ count: number }>();
    expect(auditCount?.count).toBe(1);
  });

  it("discards uncommitted encrypted ciphertext without destroyVersion", async () => {
    const destroyVersion = vi.fn();
    const store: CredentialSecretStore = {
      storageBackend: "encrypted_db",
      write: vi.fn().mockResolvedValue({
        storageBackend: "encrypted_db",
        // Missing ciphertext forces a database rollback.
      }),
      read: vi.fn(),
      destroyVersion,
    };
    vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore").mockReturnValue(store);
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key: "encrypted-db-rollback",
    });

    expect(response.status).toBe(500);
    expect(destroyVersion).not.toHaveBeenCalled();
    expect(await getDomainCounts()).toEqual({
      credentials: 0,
      connections: 0,
      wallets: 0,
    });
  });

  it("reports failed GCP cleanup without exposing the secret ref or changing the primary error", async () => {
    const store: CredentialSecretStore = {
      storageBackend: "gcp_secret_manager",
      write: vi.fn().mockResolvedValue({
        storageBackend: "gcp_secret_manager",
        secretVersionRef: "projects/sdp-test/secrets/pcred-sensitive-name/versions/11",
      }),
      read: vi.fn(),
      destroyVersion: vi.fn().mockRejectedValue(new Error("raw cleanup failure")),
    };
    vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore").mockReturnValue(store);
    const consoleError = vi.spyOn(rootLogger, "error").mockImplementation(() => undefined);
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key: "gcp-cleanup-failure",
    });

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "privy",
        storageBackend: "gcp_secret_manager",
        providerResourceVersion: 11,
        reason: "secret_cleanup_failed",
      }),
      "provider_credential_orphan_risk"
    );
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain("pcred-sensitive-name");
    expect(logged).not.toContain("raw cleanup failure");
    expect(logged).not.toContain("exact secret");
  });

  it("converges concurrent same-key submissions on one credential and connection", async () => {
    const { app, token } = buildApp();
    const [left, right] = await Promise.all([
      submit(app, token, { key: "concurrent-same-key" }),
      submit(app, token, { key: "concurrent-same-key" }),
    ]);

    expect(left.status).toBe(201);
    expect(right.status).toBe(201);
    const [leftBody, rightBody] = (await Promise.all([left.json(), right.json()])) as Array<{
      data: {
        providerCredential: { id: string };
      };
    }>;
    expect(rightBody?.data).toEqual(leftBody?.data);
    expect(await getDomainCounts()).toEqual({
      credentials: 1,
      connections: 1,
      wallets: 0,
    });

    const auditCount = await getDb(env)
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_logs
         WHERE resource_type = 'provider_credential'
           AND action = 'submit'`
      )
      .first<{ count: number }>();
    expect(auditCount?.count).toBe(1);
  });

  it("compensates the losing secret write when concurrent fresh installations race", async () => {
    let writeCount = 0;
    let releaseWrites: (() => void) | undefined;
    const writesReady = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const write = vi.fn(async ({ providerCredentialId }: { providerCredentialId: string }) => {
      writeCount += 1;
      if (writeCount === 2) {
        releaseWrites?.();
      }
      await writesReady;
      return {
        storageBackend: "gcp_secret_manager" as const,
        secretRef: `projects/sdp-test/secrets/${providerCredentialId}`,
        secretVersionRef: `projects/sdp-test/secrets/${providerCredentialId}/versions/1`,
      };
    });
    const destroyVersion = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore").mockReturnValue({
      storageBackend: "gcp_secret_manager",
      write,
      read: vi.fn(),
      destroyVersion,
    });
    const { app, token } = buildApp();

    const responses = await Promise.all([
      submit(app, token, { key: "concurrent-fresh-left" }),
      submit(app, token, { key: "concurrent-fresh-right" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const conflictResponse = responses.find((response) => response.status === 409);
    expect(await conflictResponse?.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        details: { reason: "unfinished_installation_exists" },
      },
    });
    expect(write).toHaveBeenCalledTimes(2);
    expect(destroyVersion).toHaveBeenCalledOnce();
    expect(await getDomainCounts()).toEqual({ credentials: 1, connections: 1, wallets: 0 });
  });

  it("compensates the losing GCP write in a cross-project idempotency race", async () => {
    const otherProjectId = "prj_provider_credential_submit_other";
    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          `INSERT INTO projects
             (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
        )
        .bind(
          otherProjectId,
          ORGANIZATION_ID,
          "Other Provider Credential Project",
          "other-provider-credential-project",
          USER_ID
        ),
      db
        .prepare(
          `INSERT INTO project_members (id, project_id, user_id, role)
           VALUES (?, ?, ?, 'admin')`
        )
        .bind("pm_provider_credential_submit_other", otherProjectId, USER_ID),
    ]);

    let writeCount = 0;
    let releaseWrites: (() => void) | undefined;
    const writesReady = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const write = vi.fn(async ({ providerCredentialId }: { providerCredentialId: string }) => {
      writeCount += 1;
      if (writeCount === 2) {
        releaseWrites?.();
      }
      await writesReady;
      return {
        storageBackend: "gcp_secret_manager" as const,
        secretRef: `projects/sdp-test/secrets/${providerCredentialId}`,
        secretVersionRef: `projects/sdp-test/secrets/${providerCredentialId}/versions/1`,
      };
    });
    const destroyVersion = vi.fn().mockResolvedValue(undefined);
    const store: CredentialSecretStore = {
      storageBackend: "gcp_secret_manager",
      write,
      read: vi.fn(),
      destroyVersion,
    };
    vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore").mockReturnValue(store);
    const { app, token } = buildApp();

    const responses = await Promise.all([
      submit(app, token, { key: "concurrent-mismatched-key" }),
      submit(app, token, {
        key: "concurrent-mismatched-key",
        projectId: otherProjectId,
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(write).toHaveBeenCalledTimes(2);

    const successResponse = responses.find((response) => response.status === 201);
    const successBody = (await successResponse?.json()) as
      | {
          data: {
            providerCredential: { id: string; projectId: string };
          };
        }
      | undefined;
    const winnerId = successBody?.data.providerCredential.id;
    expect(winnerId).toMatch(/^pcred_/);
    const winnerProjectId = successBody?.data.providerCredential.projectId;
    expect([PROJECT_ID, otherProjectId]).toContain(winnerProjectId);

    const writtenIds = write.mock.calls.map(([params]) => params.providerCredentialId);
    expect(new Set(writtenIds).size).toBe(2);
    expect(writtenIds).toContain(winnerId);
    const loserId = writtenIds.find((id) => id !== winnerId);
    if (!winnerId || !winnerProjectId || !loserId) {
      throw new Error("Concurrent submission did not produce distinct winner and loser IDs");
    }
    expect((await getConnectionForCredential(winnerId)).project_id).toBe(winnerProjectId);

    expect(destroyVersion).toHaveBeenCalledOnce();
    expect(destroyVersion).toHaveBeenCalledWith({
      secretVersionRef: `projects/sdp-test/secrets/${loserId}/versions/1`,
    });
    expect(destroyVersion).not.toHaveBeenCalledWith({
      secretVersionRef: `projects/sdp-test/secrets/${winnerId}/versions/1`,
    });

    const audits = await getDb(env)
      .prepare(
        `SELECT action, resource_id
         FROM audit_logs
         WHERE resource_type = 'provider_credential'
         ORDER BY action`
      )
      .all<{ action: string; resource_id: string | null }>();
    const failedAudit = audits.results.find((audit) => audit.action === "submit_failed");
    expect(failedAudit?.resource_id).toBe(loserId);
    expect(await getDomainCounts()).toEqual({
      credentials: 1,
      connections: 1,
      wallets: 0,
    });

    const persisted = await getDb(env)
      .prepare(
        `SELECT pc.id AS credential_id,
                pc.project_id AS credential_project_id,
                pc.secret_version_ref,
                c.project_id AS connection_project_id,
                c.provider_credential_id AS connection_credential_id
         FROM provider_credentials pc
         JOIN custody_connections c ON c.provider_credential_id = pc.id`
      )
      .first<{
        credential_id: string;
        credential_project_id: string;
        secret_version_ref: string;
        connection_project_id: string;
        connection_credential_id: string;
      }>();
    expect(persisted).toEqual({
      credential_id: winnerId,
      credential_project_id: winnerProjectId,
      secret_version_ref: `projects/sdp-test/secrets/${winnerId}/versions/1`,
      connection_project_id: winnerProjectId,
      connection_credential_id: winnerId,
    });
  });
});
