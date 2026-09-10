import { hashString } from "@sdp/payments/hash";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type DatabaseClient, getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError, internalError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { rootLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import type { CredentialSecretStore } from "@/services/credential-secret-store";
import * as credentialSecretStoreModule from "@/services/credential-secret-store";
import { cleanupRetiredProviderCredentialSecrets } from "@/services/jobs/cleanup-provider-credential-secrets";
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
  request_delay_ms: number | null;
  status: string;
  setup_metadata: Record<string, unknown>;
  last_check_status: string | null;
  last_check_at: string | null;
  last_check_failure_code: string | null;
};

async function getConnectionForCredential(credentialId: string): Promise<StoredConnection> {
  const connection = await getDb(env)
    .prepare(
      `SELECT id, project_id, provider, provider_credential_id, request_delay_ms, status,
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

function mockSubmissionGcp(addVersion?: (versionRef: string) => Promise<Response>) {
  env.CREDENTIAL_SECRET_STORE_BACKEND = "gcp_secret_manager";
  env.GCP_SECRET_MANAGER_PROJECT_ID = "sdp-submission-test";
  env.GCP_SECRET_MANAGER_SECRET_PREFIX = "sdp-provider-credentials";
  env.GCP_SECRET_MANAGER_API_BASE_URL = "https://gcp-submission.test";
  const requests: string[] = [];
  const writes: string[] = [];
  const destroys: string[] = [];
  const versionCounts = new Map<string, number>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (url.hostname === "metadata.google.internal") {
      return url.pathname.endsWith("/numeric-project-id")
        ? new Response("1234567890")
        : Response.json({ access_token: "dummy-test-token", expires_in: 300 });
    }
    if (url.searchParams.has("secretId")) return Response.json({});
    if (url.pathname.endsWith(":addVersion")) {
      const parent = url.pathname
        .slice(4, -":addVersion".length)
        .replace("projects/sdp-submission-test/", "projects/1234567890/");
      const version = (versionCounts.get(parent) ?? 0) + 1;
      versionCounts.set(parent, version);
      const versionRef = `${parent}/versions/${version}`;
      writes.push(versionRef);
      return addVersion ? addVersion(versionRef) : Response.json({ name: versionRef });
    }
    if (url.pathname.endsWith(":destroy")) {
      const versionRef = url.pathname
        .slice(4, -":destroy".length)
        .replace("projects/sdp-submission-test/", "projects/1234567890/");
      destroys.push(versionRef);
      return Response.json({ name: versionRef, state: "DESTROYED" });
    }
    if (url.pathname.endsWith("/versions")) {
      const parent = url.pathname
        .slice(4)
        .replace("projects/sdp-submission-test/", "projects/1234567890/");
      return Response.json({
        versions: writes
          .filter((ref) => ref.startsWith(`${parent}/`) && !destroys.includes(ref))
          .map((name) => ({ name, state: "ENABLED" })),
      });
    }
    throw new Error("Unexpected provider request");
  });
  return { requests, writes, destroys };
}

describe("POST /internal/dashboard/custody/provider-credentials", () => {
  const original = {
    deploymentMode: env.SDP_DEPLOYMENT_MODE,
    selfHostedStoredSetup: env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED,
    backend: env.CREDENTIAL_SECRET_STORE_BACKEND,
    encryptionKey: env.CUSTODY_ENCRYPTION_KEY,
    provisioningFlag: env.PRIVY_BYOK_ENABLED,
    fingerprintPepper: env.CREDENTIAL_FINGERPRINT_PEPPER,
    gcpProjectId: env.GCP_SECRET_MANAGER_PROJECT_ID,
    gcpSecretPrefix: env.GCP_SECRET_MANAGER_SECRET_PREFIX,
    gcpApiBaseUrl: env.GCP_SECRET_MANAGER_API_BASE_URL,
    privyAppId: env.PRIVY_APP_ID,
    privyAppSecret: env.PRIVY_APP_SECRET,
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
    env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = original.selfHostedStoredSetup;
    env.CREDENTIAL_SECRET_STORE_BACKEND = original.backend;
    env.CUSTODY_ENCRYPTION_KEY = original.encryptionKey;
    env.PRIVY_BYOK_ENABLED = original.provisioningFlag;
    env.CREDENTIAL_FINGERPRINT_PEPPER = original.fingerprintPepper;
    env.GCP_SECRET_MANAGER_PROJECT_ID = original.gcpProjectId;
    env.GCP_SECRET_MANAGER_SECRET_PREFIX = original.gcpSecretPrefix;
    env.GCP_SECRET_MANAGER_API_BASE_URL = original.gcpApiBaseUrl;
    env.PRIVY_APP_ID = original.privyAppId;
    env.PRIVY_APP_SECRET = original.privyAppSecret;
    await clearKVStores(env);
  });

  it("stores one pending credential and one pending project connection", async () => {
    const { app, token } = buildApp();
    const response = await submit(app, token, {
      key: "submit-privy-credentials-1",
      body: { ...VALID_BODY, requestDelayMs: 175, walletLabel: "  Treasury Wallet  " },
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
      request_delay_ms: 175,
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
    ["negative request delay", { ...VALID_BODY, requestDelayMs: -1 }],
    ["fractional request delay", { ...VALID_BODY, requestDelayMs: 1.5 }],
    ["excessive request delay", { ...VALID_BODY, requestDelayMs: 3001 }],
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

  it("accepts credential fields at the 4096-character input limit", async () => {
    const { app, token } = buildApp();
    const response = await submit(app, token, {
      key: "submit-max-length-fields",
      body: {
        ...VALID_BODY,
        fields: { ...VALID_BODY.fields, appId: "a".repeat(4096), appSecret: "s".repeat(4096) },
      },
    });

    expect(response.status).toBe(201);
  });

  it.each(["appId", "appSecret"])("rejects oversized %s before secret-store I/O", async (field) => {
    env.CREDENTIAL_SECRET_STORE_BACKEND = "gcp_secret_manager";
    env.GCP_SECRET_MANAGER_PROJECT_ID = "sdp-submission-test";
    env.GCP_SECRET_MANAGER_SECRET_PREFIX = "sdp-provider-credentials";
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 503 }));
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key: "submit-oversized-field",
      body: { ...VALID_BODY, fields: { ...VALID_BODY.fields, [field]: "x".repeat(4097) } },
    });

    expect(response.status).toBe(400);
    expect(providerFetch).not.toHaveBeenCalled();
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
        message: "Custody Connection setup is disabled for this provider",
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
    ["request delay", { ...VALID_BODY, requestDelayMs: 250 }],
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
    env.CREDENTIAL_FINGERPRINT_PEPPER = undefined;
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

  it("creates a metadata-only runtime Credential and pending Connection for self-hosted setup", async () => {
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = undefined;
    env.PRIVY_APP_ID = "runtime-app-1234";
    env.PRIVY_APP_SECRET = "runtime-secret";
    const factory = vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore");
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key: "self-hosted-runtime-submission",
      body: {
        provider: "privy",
        requestDelayMs: 125,
        walletLabel: "Runtime treasury",
      },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: { providerCredential: { id: string; label: string }; connectionId: string };
    };
    expect(body.data).toMatchObject({
      connectionId: expect.stringMatching(/^cconn_/),
      providerCredential: {
        id: expect.stringMatching(/^pcred_/),
        label: "Privy runtime credentials",
      },
    });
    expect(factory).not.toHaveBeenCalled();
    expect(await getDomainCounts()).toEqual({ credentials: 1, connections: 1, wallets: 0 });

    const credential = await getDb(env)
      .prepare(
        `SELECT source, storage_backend, secret_ref, secret_version_ref,
                encrypted_secret_payload, idempotency_fingerprint
         FROM provider_credentials
         WHERE id = ?`
      )
      .bind(body.data.providerCredential.id)
      .first<{
        source: string;
        storage_backend: string;
        secret_ref: string | null;
        secret_version_ref: string | null;
        encrypted_secret_payload: string | null;
        idempotency_fingerprint: string;
      }>();
    expect(credential).toEqual({
      source: "runtime",
      storage_backend: "runtime_env",
      secret_ref: null,
      secret_version_ref: null,
      encrypted_secret_payload: null,
      idempotency_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(await getConnectionForCredential(body.data.providerCredential.id)).toMatchObject({
      id: body.data.connectionId,
      request_delay_ms: 125,
      setup_metadata: { pendingWalletLabel: "Runtime treasury" },
      status: "pending",
    });
  });

  it.each([
    {
      name: "submitted fields for runtime setup",
      configure: () => {
        env.SDP_DEPLOYMENT_MODE = "self_hosted";
        env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = undefined;
        env.PRIVY_APP_ID = "runtime-app-1234";
        env.PRIVY_APP_SECRET = "runtime-secret";
      },
      body: VALID_BODY,
      key: "runtime-fields-mismatch",
      message: "Credential fields are not accepted for runtime setup",
    },
    {
      name: "missing fields for stored setup",
      configure: () => {
        env.SDP_DEPLOYMENT_MODE = "managed";
      },
      body: { provider: "privy" },
      key: "stored-fields-missing",
      message: "Credential fields are required for stored setup",
    },
  ])("rejects $name before secret or domain writes", async ({ configure, body, key, message }) => {
    configure();
    const factory = vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore");
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key,
      body,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "BAD_REQUEST", message },
    });
    expect(factory).not.toHaveBeenCalled();
    expect(await getDomainCounts()).toEqual({ credentials: 0, connections: 0, wallets: 0 });
  });

  it("replays a runtime submission before a later stored-source preference", async () => {
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = undefined;
    env.PRIVY_APP_ID = "runtime-app-replay";
    env.PRIVY_APP_SECRET = "runtime-secret";
    const factory = vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore");
    const { app, token } = buildApp();
    const runtimeBody = { provider: "privy", walletLabel: "Runtime replay" } as const;

    const first = await submit(app, token, {
      key: "runtime-replay-before-policy",
      body: runtimeBody,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: unknown };

    env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = "true";
    const replay = await submit(app, token, {
      key: "runtime-replay-before-policy",
      body: runtimeBody,
    });
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { data: unknown }).data).toEqual(firstBody.data);

    const freshStoredIntent = await submit(app, token, {
      key: "stored-after-runtime-policy",
      body: runtimeBody,
    });
    expect(freshStoredIntent.status).toBe(400);
    expect(await freshStoredIntent.json()).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "Credential fields are required for stored setup",
      },
    });
    expect(factory).not.toHaveBeenCalled();
    expect(await getDomainCounts()).toEqual({ credentials: 1, connections: 1, wallets: 0 });
  });

  it("rejects stored Credential replacement for a failed runtime Connection", async () => {
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = undefined;
    env.PRIVY_APP_ID = "runtime-replacement-app";
    env.PRIVY_APP_SECRET = "runtime-replacement-secret";
    const factory = vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore");
    const { app, token } = buildApp();
    const created = await submit(app, token, {
      key: "runtime-replacement-v1",
      body: { provider: "privy" },
    });
    const createdBody = (await created.json()) as {
      data: { providerCredential: { id: string }; connectionId: string };
    };
    await markInitialValidationFailed(getDb(env), {
      credentialId: createdBody.data.providerCredential.id,
      connectionId: createdBody.data.connectionId,
    });

    const response = await replace(app, token, createdBody.data.connectionId, {
      key: "runtime-replacement-v2",
      body: VALID_BODY,
    });

    expect(response.status).toBe(409);
    expect(factory).not.toHaveBeenCalled();
    expect(await getDomainCounts()).toEqual({ credentials: 1, connections: 1, wallets: 0 });
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

  it("reuses the GCP container on replacement and keeps one scan owner", async () => {
    const { app, token } = buildApp();
    const gcp = mockSubmissionGcp();
    const first = await submit(app, token, { key: "shared-submission-root" });
    expect(first.status).toBe(201);
    const original = await first.json();
    await markInitialValidationFailed(getDb(env), {
      credentialId: original.data.providerCredential.id,
      connectionId: original.data.connectionId,
    });
    const replaced = await replace(app, token, original.data.connectionId, {
      key: "shared-submission-child",
    });
    expect(replaced.status).toBe(201);
    const rows = await getDb(env).queryMany<{ secret_ref: string; owns_scan: boolean }>(
      "SELECT secret_ref, secret_next_scan_at IS NOT NULL AS owns_scan FROM provider_credentials ORDER BY credential_version"
    );
    expect(rows[1]?.secret_ref).toBe(rows[0]?.secret_ref);
    expect(rows.map((row) => row.owns_scan)).toEqual([true, false]);
    expect(gcp.requests.filter((url) => url.includes("?secretId="))).toHaveLength(1);
    expect(new Set(gcp.writes).size).toBe(2);
  });

  it("finalizes its own GCP replacement reservation on the same failed Connection", async () => {
    const { app, token } = buildApp();
    const first = await submit(app, token, { key: "gcp-replacement-original" });
    expect(first.status).toBe(201);
    const original = await first.json();
    await markInitialValidationFailed(getDb(env), {
      credentialId: original.data.providerCredential.id,
      connectionId: original.data.connectionId,
    });
    const gcp = mockSubmissionGcp();
    const request = {
      key: "gcp-replacement-candidate",
      body: {
        ...VALID_BODY,
        fields: {
          ...VALID_BODY.fields,
          credentialLabel: "Replacement GCP",
          appSecret: "replacement secret",
        },
      },
    };
    const replacement = await replace(app, token, original.data.connectionId, request);
    expect(replacement.status).toBe(201);
    const created = await replacement.json();
    expect(created.data.connectionId).toBe(original.data.connectionId);
    expect(created.data.providerCredential).toMatchObject({
      status: "pending",
      label: "Replacement GCP",
    });
    expect(created.data.providerCredential.id).not.toBe(original.data.providerCredential.id);
    expect(gcp.writes).toHaveLength(1);
    expect(gcp.destroys).toEqual([]);
    const replay = await replace(app, token, original.data.connectionId, request);
    expect(replay.status).toBe(201);
    expect((await replay.json()).data).toEqual(created.data);
    const oldReplay = await submit(app, token, { key: "gcp-replacement-original" });
    expect(oldReplay.status).toBe(201);
    expect((await oldReplay.json()).data).toEqual({
      connectionId: original.data.connectionId,
      providerCredential: { ...original.data.providerCredential, status: "failed_validation" },
    });
    expect(gcp.writes).toHaveLength(1);
    expect(await getDomainCounts()).toEqual({ credentials: 2, connections: 1, wallets: 0 });
  });

  it("does not reuse the version of an abandoned GCP replacement", async () => {
    const submissionSchema = z.object({
      data: z.object({
        connectionId: z.string(),
        providerCredential: z.object({ id: z.string() }),
      }),
    });
    const { app, token } = buildApp();
    const first = await submit(app, token, { key: "version-allocation-original" });
    expect(first.status).toBe(201);
    const original = submissionSchema.parse(await first.json()).data;
    await markInitialValidationFailed(getDb(env), {
      credentialId: original.providerCredential.id,
      connectionId: original.connectionId,
    });
    let failWrite = true;
    mockSubmissionGcp(async (versionRef) => {
      if (failWrite) throw new Error("Lost addVersion response");
      return Response.json({ name: versionRef });
    });
    expect(
      await replace(app, token, original.connectionId, { key: "version-allocation-abandoned" })
    ).toMatchObject({ status: 503 });
    failWrite = false;
    const replacement = await replace(app, token, original.connectionId, {
      key: "version-allocation-next",
    });
    expect(replacement.status).toBe(201);
    expect(submissionSchema.parse(await replacement.json()).data.connectionId).toBe(
      original.connectionId
    );
    expect(
      await getDb(env).queryMany<{ credential_version: number }>(
        `SELECT credential_version FROM provider_credentials
         WHERE organization_id = ? ORDER BY credential_version`,
        [ORGANIZATION_ID]
      )
    ).toEqual([{ credential_version: 1 }, { credential_version: 2 }, { credential_version: 3 }]);
  });

  it("clears optional Connection settings when replacement omits them", async () => {
    const { app, token } = buildApp();
    const first = await submit(app, token, {
      key: "replacement-clear-label-v1",
      body: { ...VALID_BODY, requestDelayMs: 225, walletLabel: "First wallet" },
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
    expect(connection.request_delay_ms).toBeNull();
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

  it.each([
    { source: "stored", body: VALID_BODY },
    { source: "runtime", body: { provider: "privy" } },
  ] as const)(
    "admits a pending $source Connection beside the selected active Project Config",
    async ({ source, body }) => {
      if (source === "runtime") {
        env.SDP_DEPLOYMENT_MODE = "self_hosted";
        env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = undefined;
        env.PRIVY_APP_ID = "runtime-active-config-app";
        env.PRIVY_APP_SECRET = "runtime-active-config-secret";
      }
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
        key: `legacy-active-${source}-coexistence`,
        body,
      });
      expect(response.status).toBe(201);
      const responseBody = (await response.json()) as {
        data: { providerCredential: { id: string } };
      };
      expect(responseBody.data.providerCredential).toMatchObject({
        provider: "privy",
        projectId: PROJECT_ID,
        status: "pending",
      });
      expect(
        await getConnectionForCredential(responseBody.data.providerCredential.id)
      ).toMatchObject({
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
      if (source === "runtime") {
        const audits = await db
          .prepare("SELECT metadata FROM audit_logs WHERE resource_type = 'provider_credential'")
          .all();
        expect(JSON.stringify(audits.results)).not.toContain("runtime-active-config-app");
        expect(JSON.stringify(audits.results)).not.toContain("runtime-active-config-secret");
      }
    }
  );

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

  it("keeps an in-flight GCP creation replayable without a second external write", async () => {
    let started: () => void = () => undefined;
    let release: () => void = () => undefined;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gcp = mockSubmissionGcp(async (versionRef) => {
      if (gcp.writes.length === 1) {
        started();
        await released;
      }
      return Response.json({ name: versionRef });
    });
    const { app, token } = buildApp();
    const first = submit(app, token, { key: "gcp-in-flight" });
    try {
      await writing;
      const replay = await submit(app, token, { key: "gcp-in-flight" });
      expect(replay.status).toBe(503);
      expect(gcp.writes).toHaveLength(1);
      const competing = await submit(app, token, { key: "gcp-in-flight-other" });
      expect(competing.status).toBe(409);
      expect(gcp.writes).toHaveLength(1);
    } finally {
      release();
      await first;
    }
    const committed = await first;
    expect(committed.status).toBe(201);
    const committedBody = await committed.json();
    const replay = await submit(app, token, { key: "gcp-in-flight" });
    expect(replay.status).toBe(201);
    expect((await replay.json()).data).toEqual(committedBody.data);
    expect(gcp.writes).toHaveLength(1);
  });

  it("replays a successfully created GCP credential after installation cancellation", async () => {
    const gcp = mockSubmissionGcp();
    const { app, token } = buildApp();
    const response = await submit(app, token, { key: "gcp-success-then-cancel" });
    expect(response.status).toBe(201);
    const created = await response.json();
    const cancelled = await app.request(
      `/internal/dashboard/custody/connections/${created.data.connectionId}/cancel`,
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Project-ID": PROJECT_ID } },
      env
    );
    expect(cancelled.status).toBe(200);
    const replay = await submit(app, token, { key: "gcp-success-then-cancel" });
    expect(replay.status).toBe(201);
    expect((await replay.json()).data).toEqual({
      connectionId: created.data.connectionId,
      providerCredential: { ...created.data.providerCredential, status: "deactivated" },
    });
    expect(gcp.writes).toHaveLength(1);
    expect(await getDomainCounts()).toEqual({ credentials: 1, connections: 1, wallets: 0 });
  });

  it("maps an upstream secret-store failure to a safe 503 and orphan alert", async () => {
    let loseResponse = true;
    const gcp = mockSubmissionGcp(async (versionRef) => {
      if (loseResponse) throw new Error("raw upstream detail");
      return Response.json({ name: versionRef });
    });
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
      credentials: 1,
      connections: 0,
      wallets: 0,
    });
    const abandoned = await getDb(env)
      .prepare(
        `SELECT status, secret_ref, secret_version_ref, last_failure_code, secret_retention_expires_at
       FROM provider_credentials WHERE idempotency_key = ?`
      )
      .bind("upstream-secret-failure")
      .first();
    expect(abandoned).toEqual({
      status: "deactivated",
      secret_ref: expect.stringMatching(
        /^projects\/sdp-submission-test\/secrets\/sdp-provider-credentials-pcred_/
      ),
      secret_version_ref: null,
      last_failure_code: "secret_creation_abandoned",
      secret_retention_expires_at: expect.any(String),
    });
    expect(gcp.writes).toHaveLength(1);
    expect(gcp.destroys).toEqual([]);
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
        `SELECT status, metadata::jsonb ->> 'event' AS event
         FROM audit_logs
         WHERE metadata::jsonb ->> 'auditPhase' = 'outcome'`
      )
      .all<{ status: string; event: string }>();
    expect(criticalOutcomes.results).toEqual([
      { status: "failure", event: "provider_credential_submission_failed" },
    ]);

    expect((await submit(app, token, { key: "upstream-secret-failure" })).status).toBe(409);
    expect(gcp.writes).toHaveLength(1);
    loseResponse = false;
    expect((await submit(app, token, { key: "upstream-secret-failure-new" })).status).toBe(201);
    expect(gcp.writes).toHaveLength(2);
    expect(new Set(gcp.writes).size).toBe(2);
  });

  it("does not contact GCP when the credential reservation rolls back", async () => {
    const gcp = mockSubmissionGcp();
    const db = getDb(env);
    await db.execute(`ALTER TABLE provider_credentials ADD CONSTRAINT sdp_test_reject_gcp_reservation
      CHECK (status <> 'creating')`);
    const { app, token } = buildApp();
    try {
      const response = await submit(app, token, { key: "gcp-reservation-rollback" });
      expect(response.status).toBe(500);
      expect(gcp.requests).toEqual([]);
    } finally {
      await db.execute(
        "ALTER TABLE provider_credentials DROP CONSTRAINT sdp_test_reject_gcp_reservation"
      );
    }
    expect(await getDomainCounts()).toEqual({
      credentials: 0,
      connections: 0,
      wallets: 0,
    });
  });

  it.each(["submission", "replacement"] as const)(
    "destroys the acknowledged GCP version after $0 SQL finalization rolls back",
    async (operation) => {
      const db = getDb(env);
      const { app, token } = buildApp();
      let original: { connectionId: string; providerCredential: { id: string } } | undefined;
      if (operation === "replacement") {
        const response = await submit(app, token, { key: "gcp-finalization-original" });
        expect(response.status).toBe(201);
        original = z
          .object({
            data: z.object({
              connectionId: z.string(),
              providerCredential: z.object({ id: z.string() }),
            }),
          })
          .parse(await response.json()).data;
        await markInitialValidationFailed(db, {
          credentialId: original.providerCredential.id,
          connectionId: original.connectionId,
        });
      }
      const gcp = mockSubmissionGcp();
      const request = () =>
        original
          ? replace(app, token, original.connectionId, { key: "gcp-finalization-rollback" })
          : submit(app, token, { key: "gcp-finalization-rollback" });
      await db.execute(`ALTER TABLE custody_connections ADD CONSTRAINT sdp_test_reject_gcp_connection
      CHECK (status <> 'pending') NOT VALID`);
      try {
        const response = await request();
        expect(response.status).toBe(500);
        expect(gcp.writes).toHaveLength(1);
        expect(gcp.destroys).toEqual([]);
        expect(await getDomainCounts()).toEqual({
          credentials: original ? 2 : 1,
          connections: original ? 1 : 0,
          wallets: 0,
        });
        if (original) {
          expect(
            await db.queryOne(
              "SELECT status, provider_credential_id FROM custody_connections WHERE id = ?",
              [original.connectionId]
            )
          ).toEqual({ status: "failed", provider_credential_id: original.providerCredential.id });
        }
        expect(
          await db
            .prepare(
              `SELECT status, secret_ref, secret_version_ref, last_failure_code, secret_retention_expires_at
         FROM provider_credentials WHERE idempotency_key = ?`
            )
            .bind("gcp-finalization-rollback")
            .first()
        ).toEqual({
          status: "deactivated",
          secret_ref: expect.stringMatching(
            /^projects\/sdp-submission-test\/secrets\/sdp-provider-credentials-pcred_/
          ),
          secret_version_ref: gcp.writes[0]?.replace(
            "projects/1234567890/",
            "projects/sdp-submission-test/"
          ),
          last_failure_code: "secret_creation_abandoned",
          secret_retention_expires_at: expect.any(String),
        });
        expect((await request()).status).toBe(409);
        expect(gcp.writes).toHaveLength(1);
        await expect(cleanupRetiredProviderCredentialSecrets(env)).resolves.toMatchObject({
          cleaned: 1,
          failed: 0,
        });
        expect(gcp.destroys).toEqual(gcp.writes);
      } finally {
        await db.execute(
          "ALTER TABLE custody_connections DROP CONSTRAINT sdp_test_reject_gcp_connection"
        );
      }
    }
  );

  it("reconciles a committed GCP finalization after a lost COMMIT response without destroying", async () => {
    const gcp = mockSubmissionGcp();
    const db = getDb(env);
    const runTransaction = db.transaction.bind(db);
    let transactions = 0;
    vi.spyOn(db, "transaction").mockImplementation(async (callback) => {
      const result = await runTransaction(callback);
      transactions += 1;
      if (transactions === 2) throw new Error("simulated lost finalization COMMIT response");
      return result;
    });
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key: "gcp-commit-ambiguity",
    });

    expect(response.status).toBe(201);
    expect(gcp.writes).toHaveLength(1);
    expect(gcp.destroys).toEqual([]);
    const committedBody = await response.json();
    const replay = await submit(app, token, { key: "gcp-commit-ambiguity" });
    expect(replay.status).toBe(201);
    expect((await replay.json()).data).toEqual(committedBody.data);
    expect(gcp.writes).toHaveLength(1);
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
      predictFirstVersionRef: () => null,
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

  it("does not write to GCP after an unknown reservation COMMIT and keeps the key in progress", async () => {
    const gcp = mockSubmissionGcp();
    const db = getDb(env);
    const runTransaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(async (callback) => {
      await runTransaction(callback);
      throw new Error("simulated lost reservation COMMIT response");
    });
    const { app, token } = buildApp();

    const response = await submit(app, token, {
      key: "gcp-reservation-unknown",
    });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(gcp.requests).toEqual([]);
    expect(await getDomainCounts()).toEqual({ credentials: 1, connections: 0, wallets: 0 });
    expect(
      await db
        .prepare(
          `SELECT status, secret_version_ref FROM provider_credentials WHERE idempotency_key = ?`
        )
        .bind("gcp-reservation-unknown")
        .first()
    ).toEqual({ status: "creating", secret_version_ref: null });
    const replay = await submit(app, token, { key: "gcp-reservation-unknown" });
    expect(replay.status).toBe(503);
    expect(gcp.requests).toEqual([]);
    const outcome = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM audit_logs WHERE metadata::jsonb ->> 'auditPhase' = 'outcome'`
      )
      .first<{ count: number }>();
    expect(outcome?.count).toBe(0);
  });

  it.each([
    { source: "stored", body: VALID_BODY },
    { source: "runtime", body: { provider: "privy" } },
  ] as const)("converges concurrent same-key $source submissions", async ({ source, body }) => {
    if (source === "runtime") {
      env.SDP_DEPLOYMENT_MODE = "self_hosted";
      env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = undefined;
      env.PRIVY_APP_ID = "runtime-concurrent-app";
      env.PRIVY_APP_SECRET = "runtime-concurrent-secret";
    }
    const factory = vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore");
    const { app, token } = buildApp();
    const key = `concurrent-same-key-${source}`;
    const [left, right] = await Promise.all([
      submit(app, token, { key, body }),
      submit(app, token, { key, body }),
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
    if (source === "runtime") {
      expect(factory).not.toHaveBeenCalled();
    }
  });

  it("allows only one runtime submission across concurrent different keys", async () => {
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.SELF_HOSTED_STORED_CONNECTION_SETUP_ENABLED = undefined;
    env.PRIVY_APP_ID = "runtime-concurrent-different-app";
    env.PRIVY_APP_SECRET = "runtime-concurrent-different-secret";
    const factory = vi.spyOn(credentialSecretStoreModule, "createCredentialSecretStore");
    const { app, token } = buildApp();
    const body = { provider: "privy" } as const;

    const responses = await Promise.all([
      submit(app, token, { key: "runtime-concurrent-left", body }),
      submit(app, token, { key: "runtime-concurrent-right", body }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(factory).not.toHaveBeenCalled();
    expect(await getDomainCounts()).toEqual({ credentials: 1, connections: 1, wallets: 0 });
  });

  it("writes only the winning secret when concurrent fresh GCP installations race", async () => {
    const gcp = mockSubmissionGcp();
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
    expect(gcp.writes).toHaveLength(1);
    expect(gcp.destroys).toEqual([]);
    expect(await getDomainCounts()).toEqual({ credentials: 1, connections: 1, wallets: 0 });
  });

  it("rejects a cross-project idempotency race before the losing GCP secret is written", async () => {
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

    const gcp = mockSubmissionGcp();
    const { app, token } = buildApp();

    const responses = await Promise.all([
      submit(app, token, { key: "concurrent-mismatched-key" }),
      submit(app, token, {
        key: "concurrent-mismatched-key",
        projectId: otherProjectId,
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(gcp.writes).toHaveLength(1);

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

    if (!winnerId || !winnerProjectId) {
      throw new Error("Concurrent submission did not produce a winning credential");
    }
    const winnerVersionRef = `projects/1234567890/secrets/sdp-provider-credentials-${winnerId}/versions/1`;
    expect(gcp.writes).toEqual([winnerVersionRef]);
    expect((await getConnectionForCredential(winnerId)).project_id).toBe(winnerProjectId);

    expect(gcp.destroys).toEqual([]);

    const audits = await getDb(env)
      .prepare(
        `SELECT action, resource_id
         FROM audit_logs
         WHERE resource_type = 'provider_credential'
         ORDER BY action`
      )
      .all<{ action: string; resource_id: string | null }>();
    expect(audits.results.filter((audit) => audit.action === "submit")).toEqual([
      { action: "submit", resource_id: winnerId },
    ]);
    const failedAudits = audits.results.filter((audit) => audit.action === "submit_failed");
    expect(failedAudits).toHaveLength(1);
    expect(failedAudits[0]?.resource_id).not.toBe(winnerId);
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
      secret_version_ref: winnerVersionRef.replace(
        "projects/1234567890/",
        "projects/sdp-submission-test/"
      ),
      connection_project_id: winnerProjectId,
      connection_credential_id: winnerId,
    });
  });
});
