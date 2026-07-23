import { hashString } from "@sdp/payments/hash";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DatabaseClient, getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import * as credentialSecretStoreModule from "@/services/credential-secret-store";
import {
  type CredentialSecretStore,
  CredentialSecretStoreError,
} from "@/services/credential-secret-store";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
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
    provisioningFlag: env.PRIVY_BYOK_PROVISIONING_ENABLED,
    fingerprintPepper: env.CREDENTIAL_FINGERPRINT_PEPPER,
  };

  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedActor();
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.CREDENTIAL_SECRET_STORE_BACKEND = "encrypted_db";
    env.CUSTODY_ENCRYPTION_KEY = testEncryptionKey();
    env.PRIVY_BYOK_PROVISIONING_ENABLED = "true";
    env.CREDENTIAL_FINGERPRINT_PEPPER = "test-credential-fingerprint-pepper-for-unit-tests";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    env.SDP_DEPLOYMENT_MODE = original.deploymentMode;
    env.CREDENTIAL_SECRET_STORE_BACKEND = original.backend;
    env.CUSTODY_ENCRYPTION_KEY = original.encryptionKey;
    env.PRIVY_BYOK_PROVISIONING_ENABLED = original.provisioningFlag;
    env.CREDENTIAL_FINGERPRINT_PEPPER = original.fingerprintPepper;
    await clearTestDatabase(env);
    await clearKVStores(env);
  });

  it("stores one pending credential and one pending project connection", async () => {
    const { app, token } = buildApp();
    const response = await submit(app, token, {
      key: "submit-privy-credentials-1",
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Key")).toBe("submit-privy-credentials-1");
    const body = (await response.json()) as {
      data: {
        providerCredential: { id: string };
        custodyConnection: { id: string };
      };
      meta: { requestId: string; timestamp: string };
    };
    expect(body).toEqual({
      data: {
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
        custodyConnection: {
          id: expect.stringMatching(/^cconn_/),
          projectId: PROJECT_ID,
          provider: "privy",
          providerCredentialId: body.data.providerCredential.id,
          status: "pending",
          defaultCustodyWalletId: null,
          lastCheckStatus: null,
          lastCheckAt: null,
          lastCheckFailureCode: null,
          createdAt: expect.any(String),
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
    const defaults = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM custody_scope_defaults")
      .first<{ count: number }>();
    expect(defaults?.count).toBe(0);
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

  it("requires Clerk bearer authentication", async () => {
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
        message: "Credential administration requires Clerk authentication",
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
    ["extra envelope field", { ...VALID_BODY, extra: true }],
    ["extra credential field", { ...VALID_BODY, fields: { ...VALID_BODY.fields, extra: true } }],
    [
      "walletLabel",
      {
        ...VALID_BODY,
        fields: { ...VALID_BODY.fields, walletLabel: "Must not be accepted" },
      },
    ],
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
        custodyConnection: { id: string };
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

    env.PRIVY_BYOK_PROVISIONING_ENABLED = undefined;
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

  it("rejects same-key payload reuse before another secret write", async () => {
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
      body: {
        ...VALID_BODY,
        fields: {
          ...VALID_BODY.fields,
          appSecret: "different secret",
        },
      },
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
    env.PRIVY_BYOK_PROVISIONING_ENABLED = undefined;
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

  it("creates the next credential version on the same eligible failed connection", async () => {
    const { app, token } = buildApp();
    const first = await submit(app, token, {
      key: "replacement-v1",
    });
    const firstBody = (await first.json()) as {
      data: {
        providerCredential: { id: string };
        custodyConnection: { id: string };
      };
    };
    const firstCredentialId = firstBody.data.providerCredential.id;
    const connectionId = firstBody.data.custodyConnection.id;
    await markInitialValidationFailed(getDb(env), {
      credentialId: firstCredentialId,
      connectionId,
    });

    const replacement = await submit(app, token, {
      key: "replacement-v2",
      body: {
        provider: "privy",
        fields: {
          credentialLabel: "Corrected organization credential",
          scope: "organization",
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
        custodyConnection: {
          id: string;
          providerCredentialId: string;
          status: string;
          lastCheckStatus: string | null;
          lastCheckAt: string | null;
          lastCheckFailureCode: string | null;
        };
      };
    };
    expect(replacementBody.data.providerCredential).toMatchObject({
      scope: "organization",
      projectId: null,
    });
    expect(replacementBody.data.custodyConnection).toMatchObject({
      id: connectionId,
      providerCredentialId: replacementBody.data.providerCredential.id,
      status: "pending",
      lastCheckStatus: null,
      lastCheckAt: null,
      lastCheckFailureCode: null,
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
    });
    expect(oldReplay.status).toBe(201);
    expect(await oldReplay.json()).toMatchObject({
      data: {
        providerCredential: {
          id: firstCredentialId,
          status: "failed_validation",
        },
        custodyConnection: {
          id: connectionId,
          providerCredentialId: replacementBody.data.providerCredential.id,
          status: "pending",
        },
      },
    });
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
    {
      label: "an active connection",
      key: "active",
      arrange: async (db, { credentialId, connectionId }) => {
        await db.batch([
          db
            .prepare(
              `UPDATE provider_credentials
               SET status = 'active',
                   last_validated_at = sdp_iso_now()
               WHERE id = ?`
            )
            .bind(credentialId),
          db
            .prepare(
              `UPDATE custody_connections
               SET status = 'active',
                   last_check_status = 'success',
                   last_check_at = sdp_iso_now(),
                   activated_at = sdp_iso_now()
               WHERE id = ?`
            )
            .bind(connectionId),
        ]);
      },
    },
    {
      label: "a failed connection whose credential is still pending",
      key: "failed-credential-pending",
      arrange: async (db, { connectionId }) => {
        await db
          .prepare(
            `UPDATE custody_connections
             SET status = 'failed',
                 last_check_status = 'failed',
                 last_check_at = sdp_iso_now(),
                 last_check_failure_code = 'invalid_credentials'
             WHERE id = ?`
          )
          .bind(connectionId)
          .run();
      },
    },
    {
      label: "a failed connection with a default wallet",
      key: "failed-default-wallet",
      arrange: async (db, ids) => {
        const custodyConfigId = "cust_rejected_replacement";
        const walletId = "cwal_rejected_replacement";
        await markInitialValidationFailed(db, ids);
        await db.batch([
          db
            .prepare(
              `INSERT INTO custody_configs (
                 id, organization_id, project_id, provider, config_encrypted,
                 encryption_version, status
               ) VALUES (?, ?, ?, 'privy', 'legacy', 'test', 'inactive')`
            )
            .bind(custodyConfigId, ORGANIZATION_ID, PROJECT_ID),
          db
            .prepare(
              `INSERT INTO custody_wallets (
                 id, custody_config_id, wallet_id, public_key, label, status
               ) VALUES (?, ?, 'privy-wallet-1', 'wallet-public-key-1', 'Default', 'active')`
            )
            .bind(walletId, custodyConfigId),
          db
            .prepare(
              `UPDATE custody_connections
               SET default_custody_wallet_id = ?
               WHERE id = ?`
            )
            .bind(walletId, ids.connectionId),
        ]);
      },
    },
    {
      label: "a failed connection with pinned setup metadata",
      key: "failed-pinned-account",
      arrange: async (db, ids) => {
        await markInitialValidationFailed(db, ids);
        await db
          .prepare(
            `UPDATE custody_connections
             SET setup_metadata =
               '{"providerAccountFingerprint":"privy:api.privy.io:sha256:test-only"}'::jsonb
             WHERE id = ?`
          )
          .bind(ids.connectionId)
          .run();
      },
    },
    {
      label: "multiple non-deactivated connections",
      key: "multiple-connections",
      arrange: async (db) => {
        await db.batch([
          db
            .prepare(
              `INSERT INTO provider_credentials (
                 id, organization_id, project_id, provider, label, scope, source,
                 storage_backend, encrypted_secret_payload, status, created_by
               ) VALUES (
                 ?, ?, ?, 'privy', 'Second credential', 'project', 'stored',
                 'encrypted_db', 'ciphertext:second', 'pending', ?
               )`
            )
            .bind("pcred_second_connection", ORGANIZATION_ID, PROJECT_ID, USER_ID),
          db
            .prepare(
              `INSERT INTO custody_connections (
                 id, organization_id, project_id, provider, scope,
                 provider_credential_id, provider_credential_scope_key,
                 status, created_by
               ) VALUES (
                 ?, ?, ?, 'privy', 'project', ?, ?, 'pending', ?
               )`
            )
            .bind(
              "cconn_second_connection",
              ORGANIZATION_ID,
              PROJECT_ID,
              "pcred_second_connection",
              PROJECT_ID,
              USER_ID
            ),
        ]);
      },
    },
  ] satisfies RejectedReplacementCase[])("rejects a new credential when the project already has $label", async ({
    key,
    arrange,
  }) => {
    const { app, token } = buildApp();
    const initial = await submit(app, token, {
      key: `blocked-${key}-initial`,
    });
    expect(initial.status).toBe(201);
    const initialBody = (await initial.json()) as {
      data: {
        providerCredential: { id: string };
        custodyConnection: { id: string };
      };
    };
    const db = getDb(env);
    await arrange(db, {
      credentialId: initialBody.data.providerCredential.id,
      connectionId: initialBody.data.custodyConnection.id,
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
        message: "Privy custody setup already exists for this project",
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
  });

  it("reinstalls as a new root and preserves deactivated lineage replay", async () => {
    const { app, token } = buildApp();
    const first = await submit(app, token, {
      key: "deactivated-lineage-v1",
    });
    const firstBody = (await first.json()) as {
      data: {
        providerCredential: { id: string };
        custodyConnection: { id: string };
      };
    };

    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'deactivated',
             deactivated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(firstBody.data.custodyConnection.id)
      .run();

    const reinstall = await submit(app, token, {
      key: "deactivated-lineage-reinstall",
    });
    expect(reinstall.status).toBe(201);
    const reinstallBody = (await reinstall.json()) as {
      data: {
        providerCredential: { id: string };
        custodyConnection: { id: string };
      };
    };
    expect(reinstallBody.data.providerCredential.id).not.toBe(firstBody.data.providerCredential.id);
    expect(reinstallBody.data.custodyConnection.id).not.toBe(firstBody.data.custodyConnection.id);

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
    expect(await oldReplay.json()).toMatchObject({
      data: {
        providerCredential: { id: firstBody.data.providerCredential.id },
        custodyConnection: {
          id: firstBody.data.custodyConnection.id,
          status: "deactivated",
        },
      },
    });
    expect(await getDomainCounts()).toEqual({
      credentials: 2,
      connections: 2,
      wallets: 0,
    });
  });

  it("blocks only an active exact-project legacy Privy config", async () => {
    const factory = vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore");
    await getDb(env)
      .prepare(
        `INSERT INTO custody_configs (
           id, organization_id, project_id, provider, config_encrypted,
           encryption_version, status
         ) VALUES (?, ?, ?, 'privy', 'legacy', 'test', 'active')`
      )
      .bind("cust_active_exact_project", ORGANIZATION_ID, PROJECT_ID)
      .run();
    const { app, token } = buildApp();

    const blocked = await submit(app, token, {
      key: "legacy-active-conflict",
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        message: "Privy custody setup already exists for this project",
      },
    });
    expect(factory).not.toHaveBeenCalled();
    expect(await getDomainCounts()).toEqual({
      credentials: 0,
      connections: 0,
      wallets: 0,
    });
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
  ] as const)("fails closed before secret storage when CREDENTIAL_FINGERPRINT_PEPPER is %s", async (_case, value) => {
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
  });

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
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
      "provider_credential_orphan_risk",
      expect.objectContaining({
        provider: "privy",
        storageBackend: "gcp_secret_manager",
        requestId: "req_provider_credential_submit",
        reason: "secret_write_outcome_unknown",
      })
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("raw upstream detail");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("exact secret");
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
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key: "gcp-cleanup-failure",
    });

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "provider_credential_orphan_risk",
      expect.objectContaining({
        provider: "privy",
        storageBackend: "gcp_secret_manager",
        providerResourceVersion: 11,
        reason: "secret_cleanup_failed",
      })
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
        custodyConnection: { id: string };
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
            custodyConnection: { projectId: string };
          };
        }
      | undefined;
    const winnerId = successBody?.data.providerCredential.id;
    expect(winnerId).toMatch(/^pcred_/);
    const winnerProjectId = successBody?.data.providerCredential.projectId;
    expect(successBody?.data.custodyConnection.projectId).toBe(winnerProjectId);
    expect([PROJECT_ID, otherProjectId]).toContain(winnerProjectId);

    const writtenIds = write.mock.calls.map(([params]) => params.providerCredentialId);
    expect(new Set(writtenIds).size).toBe(2);
    expect(writtenIds).toContain(winnerId);
    const loserId = writtenIds.find((id) => id !== winnerId);
    if (!winnerId || !winnerProjectId || !loserId) {
      throw new Error("Concurrent submission did not produce distinct winner and loser IDs");
    }

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
