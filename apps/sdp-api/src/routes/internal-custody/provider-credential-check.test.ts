import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError, internalError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { AuditService } from "@/services/audit.service";
import * as credentialSecretStore from "@/services/credential-secret-store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import internalCustody from "./index";

const ORGANIZATION_ID = "org_provider_credential_installation";
const PROJECT_ID = "prj_provider_credential_installation";
const USER_ID = "usr_provider_credential_installation";
const CREDENTIAL_ID = "pcred_provider_credential_installation";
const CONNECTION_ID = "cconn_provider_credential_installation";
const LEGACY_CONFIG_ID = "cust_cfg_provider_credential_installation";
const APP_ID = "privy-app-1234";
const APP_SECRET = "exact secret";
const WALLET_LABEL = "Treasury Wallet";
const PRIVY_WALLET_ID = "wallet-provider-credential-installation";
const PRIVY_WALLET_ADDRESS = "wallet-address-provider-credential-installation";
const PRIVY_EXTERNAL_ID = `sdp_${CONNECTION_ID}`;
const PRIVY_IDEMPOTENCY_KEY = `sdp_install_${CONNECTION_ID}`;
const PRIVY_EXTERNAL_WALLET_URL = `https://privy.example.test/v1/wallets/ext_wal_${PRIVY_EXTERNAL_ID}`;
const PROVIDER_ACCOUNT_FINGERPRINT =
  "sha256:227b73d3e3e9e6717d2c6f6500f88386b11130922ae7320de715a6ca237f3296";

type RouteAction = "complete" | "cancel";

function privyJson(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function privyWalletResponse(externalId = PRIVY_EXTERNAL_ID): Response {
  return privyJson({
    id: PRIVY_WALLET_ID,
    address: PRIVY_WALLET_ADDRESS,
    chain_type: "solana",
    external_id: externalId,
  });
}

function successfulPrivyFetch(connectionId = CONNECTION_ID) {
  const externalId = `sdp_${connectionId}`;
  const providerFetch = vi
    .fn()
    .mockResolvedValueOnce(privyJson({ data: [], next_cursor: null }))
    .mockResolvedValueOnce(privyJson({ error: "wallet not found" }, 404))
    .mockResolvedValueOnce(privyWalletResponse(externalId));
  vi.stubGlobal("fetch", providerFetch);
  return providerFetch;
}

function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createJwt(payload: ClerkJwtPayload): string {
  return `${encodeJwtPart({ alg: "RS256", typ: "JWT" })}.${encodeJwtPart(payload)}.signature`;
}

function testEncryptionKey(): string {
  return Buffer.alloc(32, 11).toString("base64");
}

function buildApp(options: { injectJwt?: boolean } = {}) {
  const token = createJwt({
    sub: "clerk_provider_credential_installation",
    org_id: "clerk_org_provider_credential_installation",
    org_role: "org:admin",
    email: "provider-credential-installation@example.com",
  });
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", kvStoreMiddleware());
  app.use("*", async (c, next) => {
    if (options.injectJwt !== false) {
      c.set("verifiedClerkJwt", {
        token,
        payload: {
          sub: "clerk_provider_credential_installation",
          org_id: "clerk_org_provider_credential_installation",
          org_role: "org:admin",
          email: "provider-credential-installation@example.com",
        },
      });
    }
    c.set("requestId", "req_provider_credential_installation");
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

async function seedProject(projectId: string, slug: string): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO projects (
           id, organization_id, name, slug, environment, status, created_by
         ) VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
      )
      .bind(projectId, ORGANIZATION_ID, slug, slug, USER_ID),
    db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, 'admin')`
      )
      .bind(`pm_${slug}`, projectId, USER_ID),
  ]);
}

async function seedActor(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, ?, ?, 'individual', 'active')`
      )
      .bind(
        ORGANIZATION_ID,
        "Provider Credential Installation",
        "provider-credential-installation"
      ),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, ?, 1, 'active')`
      )
      .bind(USER_ID, "provider-credential-installation@example.com"),
    db
      .prepare(
        `INSERT INTO auth_user_identities (
           id, provider, provider_user_id, user_id, email
         ) VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind(
        "aui_provider_credential_installation",
        "clerk_provider_credential_installation",
        USER_ID,
        "provider-credential-installation@example.com"
      ),
    db
      .prepare(
        `INSERT INTO auth_organization_identities (
           id, provider, provider_org_id, organization_id, slug
         ) VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind(
        "aoi_provider_credential_installation",
        "clerk_org_provider_credential_installation",
        ORGANIZATION_ID,
        "provider-credential-installation"
      ),
    db
      .prepare(
        `INSERT INTO organization_members (
           id, organization_id, user_id, role, status
         ) VALUES (?, ?, ?, 'admin', 'active')`
      )
      .bind("mem_provider_credential_installation", ORGANIZATION_ID, USER_ID),
  ]);
  await seedProject(PROJECT_ID, "provider-credential-installation");
}

async function seedPendingInstallation(
  options: {
    projectId?: string;
    credentialId?: string;
    connectionId?: string;
    appId?: string;
    appSecret?: string;
    walletLabel?: string;
  } = {}
): Promise<void> {
  const projectId = options.projectId ?? PROJECT_ID;
  const credentialId = options.credentialId ?? CREDENTIAL_ID;
  const connectionId = options.connectionId ?? CONNECTION_ID;
  const appId = options.appId ?? APP_ID;
  const appSecret = options.appSecret ?? APP_SECRET;
  const walletLabel = options.walletLabel ?? WALLET_LABEL;
  const stored = await credentialSecretStore.createCredentialSecretStore(env).write({
    orgId: ORGANIZATION_ID,
    provider: "privy",
    providerCredentialId: credentialId,
    payload: { appId: `  ${appId}  `, appSecret },
  });
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO provider_credentials (
           id, organization_id, project_id, provider, label, scope, source,
           storage_backend, secret_ref, secret_version_ref, encrypted_secret_payload,
           display_metadata, status, credential_version, created_by
         ) VALUES (
           ?, ?, ?, 'privy', 'Treasury Privy', 'project', 'stored',
           ?, ?, ?, ?, '{"appIdSuffix":"1234"}'::jsonb, 'pending', 1, ?
         )`
      )
      .bind(
        credentialId,
        ORGANIZATION_ID,
        projectId,
        stored.storageBackend,
        stored.secretRef ?? null,
        stored.secretVersionRef ?? null,
        stored.encryptedSecretPayload ?? null,
        USER_ID
      ),
    db
      .prepare(
        `INSERT INTO custody_connections (
           id, organization_id, project_id, provider, scope,
           provider_credential_id, provider_credential_scope_key,
           setup_metadata, status, created_by
         ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, ?, 'pending', ?)`
      )
      .bind(
        connectionId,
        ORGANIZATION_ID,
        projectId,
        credentialId,
        projectId,
        JSON.stringify(walletLabel ? { pendingWalletLabel: walletLabel } : {}),
        USER_ID
      ),
  ]);
}

async function seedActiveFingerprintConnection(
  options: {
    projectId?: string;
    credentialId?: string;
    connectionId?: string;
    fingerprint?: string;
  } = {}
): Promise<void> {
  const projectId = options.projectId ?? PROJECT_ID;
  const credentialId = options.credentialId ?? "pcred_existing_privy";
  const connectionId = options.connectionId ?? "cconn_existing_privy";
  const fingerprint = options.fingerprint ?? PROVIDER_ACCOUNT_FINGERPRINT;
  const custodyWalletId = `cwlt_existing_${connectionId}`;
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO provider_credentials (
           id, organization_id, project_id, provider, label, scope, source,
           storage_backend, encrypted_secret_payload, display_metadata,
           status, credential_version, created_by
         ) VALUES (
           ?, ?, ?, 'privy', 'Existing Privy', 'project', 'stored',
           'encrypted_db', 'opaque', '{}'::jsonb, 'active', 1, ?
         )`
      )
      .bind(credentialId, ORGANIZATION_ID, projectId, USER_ID),
    db
      .prepare(
        `INSERT INTO custody_connections (
           id, organization_id, project_id, provider, scope,
           provider_credential_id, provider_credential_scope_key,
           provider_account_fingerprint, status, last_check_status,
           last_check_at, created_by
         ) VALUES (
           ?, ?, ?, 'privy', 'project', ?, ?, ?, 'failed', 'failed',
           sdp_iso_now(), ?
         )`
      )
      .bind(
        connectionId,
        ORGANIZATION_ID,
        projectId,
        credentialId,
        projectId,
        fingerprint,
        USER_ID
      ),
    db
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_connection_id, wallet_id, public_key, status
         ) VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(
        custodyWalletId,
        connectionId,
        `existing-wallet-${connectionId}`,
        `existing-address-${connectionId}`
      ),
    db
      .prepare(
        `UPDATE custody_connections
         SET status = 'active', default_custody_wallet_id = ?,
             last_check_status = 'success', last_check_at = sdp_iso_now(),
             activated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(custodyWalletId, connectionId),
  ]);
}

async function seedLegacyDefault(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (
           id, organization_id, project_id, provider, config_encrypted,
           encryption_version, default_wallet_id, status
         ) VALUES (?, ?, ?, 'privy', 'legacy-config', 'test', 'legacy-wallet', 'active')`
      )
      .bind(LEGACY_CONFIG_ID, ORGANIZATION_ID, PROJECT_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_config_id, wallet_id, public_key, status
         ) VALUES (
           'cwlt_provider_credential_installation_legacy', ?, 'legacy-wallet',
           'legacy-wallet-address', 'active'
         )`
      )
      .bind(LEGACY_CONFIG_ID),
    db
      .prepare(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id, default_custody_config_id
         ) VALUES ('csd_provider_credential_installation', ?, ?, ?)`
      )
      .bind(ORGANIZATION_ID, PROJECT_ID, LEGACY_CONFIG_ID),
  ]);
}

async function installationRequest(
  app: Hono<{ Bindings: Env }>,
  token: string,
  action: RouteAction,
  options: { connectionId?: string; projectId?: string } = {}
): Promise<Response> {
  return app.request(
    `/internal/dashboard/custody/connections/${options.connectionId ?? CONNECTION_ID}/${action}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Project-ID": options.projectId ?? PROJECT_ID,
      },
    },
    env
  );
}

async function getInstallation(
  app: Hono<{ Bindings: Env }>,
  token: string,
  options: { connectionId?: string; projectId?: string } = {}
): Promise<Response> {
  return app.request(
    `/internal/dashboard/custody/connections/${options.connectionId ?? CONNECTION_ID}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Project-ID": options.projectId ?? PROJECT_ID,
      },
    },
    env
  );
}

async function getState(connectionId = CONNECTION_ID): Promise<{
  credential_status: string;
  encrypted_secret_payload: string | null;
  connection_status: string;
  setup_metadata: Record<string, unknown>;
  provider_account_fingerprint: string | null;
  last_check_status: string | null;
  last_check_at: string | null;
  last_check_failure_code: string | null;
  default_custody_wallet_id: string | null;
  activated_at: string | null;
  deactivated_at: string | null;
}> {
  const state = await getDb(env)
    .prepare(
      `SELECT pc.status AS credential_status, pc.encrypted_secret_payload,
              c.status AS connection_status, c.setup_metadata,
              c.provider_account_fingerprint, c.last_check_status,
              c.last_check_at, c.last_check_failure_code,
              c.default_custody_wallet_id, c.activated_at, c.deactivated_at
       FROM custody_connections c
       JOIN provider_credentials pc ON pc.id = c.provider_credential_id
       WHERE c.id = ?`
    )
    .bind(connectionId)
    .first<{
      credential_status: string;
      encrypted_secret_payload: string | null;
      connection_status: string;
      setup_metadata: Record<string, unknown>;
      provider_account_fingerprint: string | null;
      last_check_status: string | null;
      last_check_at: string | null;
      last_check_failure_code: string | null;
      default_custody_wallet_id: string | null;
      activated_at: string | null;
      deactivated_at: string | null;
    }>();
  if (!state) throw new Error("Installation state not found");
  return state;
}

describe("exact Custody Connection installation routes", () => {
  const original = {
    deploymentMode: env.SDP_DEPLOYMENT_MODE,
    backend: env.CREDENTIAL_SECRET_STORE_BACKEND,
    encryptionKey: env.CUSTODY_ENCRYPTION_KEY,
    byokEnabled: env.PRIVY_BYOK_ENABLED,
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    apiBaseUrl: env.PRIVY_API_BASE_URL,
  };

  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    env.SDP_DEPLOYMENT_MODE = "managed";
    env.CREDENTIAL_SECRET_STORE_BACKEND = "encrypted_db";
    env.CUSTODY_ENCRYPTION_KEY = testEncryptionKey();
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = undefined;
    env.PRIVY_APP_SECRET = undefined;
    env.PRIVY_API_BASE_URL = "https://privy.example.test/v1";
    await seedActor();
    await seedPendingInstallation();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    env.SDP_DEPLOYMENT_MODE = original.deploymentMode;
    env.CREDENTIAL_SECRET_STORE_BACKEND = original.backend;
    env.CUSTODY_ENCRYPTION_KEY = original.encryptionKey;
    env.PRIVY_BYOK_ENABLED = original.byokEnabled;
    env.PRIVY_APP_ID = original.appId;
    env.PRIVY_APP_SECRET = original.appSecret;
    env.PRIVY_API_BASE_URL = original.apiBaseUrl;
    await clearKVStores(env);
  });

  it("completes an exact Connection and replays terminal success without changing the Config target", async () => {
    await seedLegacyDefault();
    const providerFetch = successfulPrivyFetch();
    const { app, token } = buildApp();

    const response = await installationRequest(app, token, "complete");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { completion: { attemptedAt: string } };
    };
    expect(body).toEqual({
      data: {
        providerCredential: {
          id: CREDENTIAL_ID,
          provider: "privy",
          label: "Treasury Privy",
          scope: "project",
          projectId: PROJECT_ID,
          status: "active",
          createdAt: expect.any(String),
          displayMetadata: { appIdSuffix: "1234" },
        },
        connectionId: CONNECTION_ID,
        completion: { status: "success", attemptedAt: expect.any(String) },
      },
      meta: {
        requestId: "req_provider_credential_installation",
        timestamp: expect.any(String),
      },
    });
    expect(providerFetch).toHaveBeenCalledTimes(3);
    expect(providerFetch.mock.calls[0]?.[0]).toBe(
      "https://privy.example.test/v1/wallets?limit=1&chain_type=solana"
    );
    expect(providerFetch.mock.calls[1]?.[0]).toBe(PRIVY_EXTERNAL_WALLET_URL);
    expect(providerFetch.mock.calls[2]).toEqual([
      "https://privy.example.test/v1/wallets",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "privy-idempotency-key": PRIVY_IDEMPOTENCY_KEY }),
        body: JSON.stringify({ chain_type: "solana", external_id: PRIVY_EXTERNAL_ID }),
      }),
    ]);

    expect(await getState()).toMatchObject({
      credential_status: "active",
      connection_status: "active",
      setup_metadata: {},
      provider_account_fingerprint: PROVIDER_ACCOUNT_FINGERPRINT,
      last_check_status: "success",
      last_check_failure_code: null,
      default_custody_wallet_id: expect.any(String),
      activated_at: expect.any(String),
    });
    expect(
      await getDb(env)
        .prepare(
          `SELECT w.wallet_id, w.public_key, w.label, w.custody_config_id,
                  w.custody_connection_id,
                  d.default_custody_config_id, d.default_custody_connection_id,
                  (SELECT COUNT(*) FROM custody_wallets) AS wallet_count
           FROM custody_connections c
           JOIN custody_wallets w ON w.id = c.default_custody_wallet_id
           LEFT JOIN custody_scope_defaults d
             ON d.organization_id = c.organization_id AND d.project_id = c.project_id
           WHERE c.id = ?`
        )
        .bind(CONNECTION_ID)
        .first()
    ).toMatchObject({
      wallet_id: `privy_${PRIVY_WALLET_ID}`,
      public_key: PRIVY_WALLET_ADDRESS,
      label: WALLET_LABEL,
      custody_config_id: null,
      custody_connection_id: CONNECTION_ID,
      default_custody_config_id: LEGACY_CONFIG_ID,
      default_custody_connection_id: null,
      wallet_count: 2,
    });

    env.PRIVY_BYOK_ENABLED = "false";
    providerFetch.mockClear();
    const secretFactory = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    const replay = await installationRequest(app, token, "complete");

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: {
        providerCredential: { id: CREDENTIAL_ID, status: "active" },
        connectionId: CONNECTION_ID,
        completion: { status: "success", attemptedAt: body.data.completion.attemptedAt },
      },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(secretFactory).not.toHaveBeenCalled();
  });

  it("keeps completion successful and replayable when its audit outcome cannot be persisted", async () => {
    const completeCritical = vi
      .spyOn(AuditService.prototype, "completeCritical")
      .mockResolvedValue(false);
    const providerFetch = successfulPrivyFetch();
    const { app, token } = buildApp();

    const completed = await installationRequest(app, token, "complete");
    const replay = await installationRequest(app, token, "complete");

    expect(completed.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: { connectionId: CONNECTION_ID, completion: { status: "success" } },
    });
    expect(providerFetch).toHaveBeenCalledTimes(3);
    expect(completeCritical).toHaveBeenCalledOnce();
    expect(await getState()).toMatchObject({
      credential_status: "active",
      connection_status: "active",
      last_check_status: "success",
    });
  });

  it("records a recovered completion after a lost COMMIT response", async () => {
    successfulPrivyFetch();
    const db = getDb(env);
    const runTransaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(async (callback) => {
      await runTransaction(callback);
      throw new Error("simulated lost COMMIT response");
    });
    const { app, token } = buildApp();

    const response = await installationRequest(app, token, "complete");

    expect(response.status).toBe(200);
    expect(await getState()).toMatchObject({
      credential_status: "active",
      connection_status: "active",
      last_check_status: "success",
    });
    const audit = await db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_logs
         WHERE action = 'check' AND resource_id = ?`
      )
      .bind(CONNECTION_ID)
      .first<{ count: number }>();
    expect(audit?.count).toBe(1);
  });

  it("performs no Provider I/O when the completion audit intent cannot be persisted", async () => {
    vi.spyOn(AuditService.prototype, "beginCritical").mockRejectedValue(internalError());
    const providerFetch = successfulPrivyFetch();
    const { app, token } = buildApp();

    const response = await installationRequest(app, token, "complete");

    expect(response.status).toBe(500);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await getState()).toMatchObject({
      credential_status: "pending",
      connection_status: "pending",
      last_check_status: null,
      provider_account_fingerprint: null,
      default_custody_wallet_id: null,
    });
  });

  it("accepts an organization admin dashboard session", async () => {
    const sessionId = "ses_provider_credential_installation";
    await getDb(env)
      .prepare(
        `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
         VALUES (?, ?, ?, 'session', ?)`
      )
      .bind(sessionId, USER_ID, ORGANIZATION_ID, "2999-01-01T00:00:00.000Z")
      .run();
    successfulPrivyFetch();
    const { app } = buildApp({ injectJwt: false });

    const response = await app.request(
      `/internal/dashboard/custody/connections/${CONNECTION_ID}/complete`,
      {
        method: "POST",
        headers: {
          Cookie: `sdp_session=${sessionId}`,
          "X-Project-ID": PROJECT_ID,
        },
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { connectionId: CONNECTION_ID, completion: { status: "success" } },
    });
  });

  it("returns retry_unknown without terminally changing the installation", async () => {
    const providerFetch = vi.fn().mockResolvedValue(privyJson({ error: "temporary" }, 503));
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const response = await installationRequest(app, token, "complete");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        providerCredential: { id: CREDENTIAL_ID, status: "pending" },
        connectionId: CONNECTION_ID,
        completion: {
          status: "retry_unknown",
          attemptedAt: expect.any(String),
          code: "provider_response_unknown",
        },
      },
    });
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(await getState()).toMatchObject({
      credential_status: "pending",
      connection_status: "pending",
      provider_account_fingerprint: null,
      last_check_status: "retry_unknown",
      last_check_failure_code: "provider_response_unknown",
      default_custody_wallet_id: null,
    });
  });

  it("stores invalid credentials as a redacted terminal failure and replays it flag-off", async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValue(privyJson({ error: "raw provider credential detail" }, 401));
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const failed = await installationRequest(app, token, "complete");

    expect(failed.status).toBe(200);
    const failedBody = (await failed.json()) as {
      data: { completion: { attemptedAt: string } };
    };
    expect(failedBody).toMatchObject({
      data: {
        providerCredential: { id: CREDENTIAL_ID, status: "failed_validation" },
        connectionId: CONNECTION_ID,
        completion: {
          status: "failed",
          attemptedAt: expect.any(String),
          code: "invalid_credentials",
        },
      },
    });
    expect(JSON.stringify(failedBody)).not.toContain("raw provider credential detail");
    expect(JSON.stringify(failedBody)).not.toContain(APP_ID);
    expect(JSON.stringify(failedBody)).not.toContain(APP_SECRET);
    expect(await getState()).toMatchObject({
      credential_status: "failed_validation",
      encrypted_secret_payload: null,
      connection_status: "failed",
      provider_account_fingerprint: null,
      last_check_status: "failed",
      last_check_failure_code: "invalid_credentials",
    });

    env.PRIVY_BYOK_ENABLED = "false";
    providerFetch.mockClear();
    const secretFactory = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    const replay = await installationRequest(app, token, "complete");

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: {
        providerCredential: { status: "failed_validation" },
        completion: {
          status: "failed",
          attemptedAt: failedBody.data.completion.attemptedAt,
          code: "invalid_credentials",
        },
      },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(secretFactory).not.toHaveBeenCalled();
  });

  it("destroys a rejected GCP secret version only after terminal state is committed", async () => {
    const secretRef = "projects/sdp-test/secrets/sdp-provider-credentials-installation";
    const secretVersionRef = `${secretRef}/versions/7`;
    await getDb(env)
      .prepare(
        `UPDATE provider_credentials
         SET storage_backend = 'gcp_secret_manager', secret_ref = ?,
             secret_version_ref = ?, encrypted_secret_payload = NULL
         WHERE id = ?`
      )
      .bind(secretRef, secretVersionRef, CREDENTIAL_ID)
      .run();
    const destroyVersion = vi.fn(async () => {
      expect(await getState()).toMatchObject({
        credential_status: "failed_validation",
        connection_status: "failed",
        last_check_status: "failed",
      });
    });
    const factory = vi.spyOn(credentialSecretStore, "createCredentialSecretStore").mockReturnValue({
      storageBackend: "gcp_secret_manager",
      write: vi.fn(),
      read: vi.fn().mockResolvedValue({ appId: APP_ID, appSecret: APP_SECRET }),
      destroyVersion,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(privyJson({ error: "invalid" }, 401)));
    const { app, token } = buildApp();

    const response = await installationRequest(app, token, "complete");

    expect(response.status).toBe(200);
    expect(factory).toHaveBeenCalledWith(env, "gcp_secret_manager");
    expect(destroyVersion).toHaveBeenCalledOnce();
    expect(destroyVersion).toHaveBeenCalledWith({ secretVersionRef });
  });

  it("blocks flag-off completion before fingerprint but reconciles a pinned installation by GET only", async () => {
    env.PRIVY_BYOK_ENABLED = "false";
    const { app, token } = buildApp();
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const secretFactory = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");

    const disabled = await installationRequest(app, token, "complete");

    expect(disabled.status).toBe(403);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(secretFactory).not.toHaveBeenCalled();

    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET provider_account_fingerprint = ?
         WHERE id = ?`
      )
      .bind(PROVIDER_ACCOUNT_FINGERPRINT, CONNECTION_ID)
      .run();
    providerFetch.mockResolvedValueOnce(privyWalletResponse());
    secretFactory.mockClear();

    const reconciled = await installationRequest(app, token, "complete");

    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({
      data: {
        providerCredential: { status: "active" },
        connectionId: CONNECTION_ID,
        completion: { status: "success" },
      },
    });
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(providerFetch.mock.calls[0]?.[0]).toBe(PRIVY_EXTERNAL_WALLET_URL);
    expect(providerFetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(providerFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(secretFactory).toHaveBeenCalledOnce();
  });

  it("rejects a current completion lease with a stable reason before secret or Provider access", async () => {
    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'checking', last_check_status = 'running', last_check_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(CONNECTION_ID)
      .run();
    const { app, token } = buildApp();
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const secretFactory = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");

    const response = await installationRequest(app, token, "complete");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "CONFLICT", details: { reason: "completion_in_progress" } },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(secretFactory).not.toHaveBeenCalled();
  });

  it("admits one Provider sequence while an exact completion lease is current", async () => {
    let enterValidation: (() => void) | undefined;
    let releaseValidation: (() => void) | undefined;
    const validationEntered = new Promise<void>((resolve) => {
      enterValidation = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/wallets?limit=1&chain_type=solana")) {
        enterValidation?.();
        await validationGate;
        return privyJson({ data: [] });
      }
      if (url === PRIVY_EXTERNAL_WALLET_URL) return privyJson({ error: "not found" }, 404);
      if (init?.method === "POST") return privyWalletResponse();
      throw new Error(`Unexpected Privy request: ${url}`);
    });
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const firstPromise = installationRequest(app, token, "complete");
    await validationEntered;
    const second = await installationRequest(app, token, "complete");

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      error: { details: { reason: "completion_in_progress" } },
    });
    releaseValidation?.();
    const first = await firstPromise;
    expect(first.status).toBe(200);
    expect(providerFetch).toHaveBeenCalledTimes(3);
    expect(providerFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("reclaims an expired lease with a strictly newer token", async () => {
    const expiredToken = "2000-01-01T00:00:00.000Z";
    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'checking', last_check_status = 'running', last_check_at = ?
         WHERE id = ?`
      )
      .bind(expiredToken, CONNECTION_ID)
      .run();
    successfulPrivyFetch();
    const { app, token } = buildApp();

    const response = await installationRequest(app, token, "complete");

    expect(response.status).toBe(200);
    const state = await getState();
    expect(state.last_check_status).toBe("success");
    expect(Date.parse(state.last_check_at ?? "")).toBeGreaterThan(Date.parse(expiredToken));
  });

  it("does not let a stale lease token overwrite a newer successful completion", async () => {
    let firstValidationEntered: (() => void) | undefined;
    let releaseFirstValidation: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      firstValidationEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstValidation = resolve;
    });
    let validationCalls = 0;
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/wallets?limit=1&chain_type=solana")) {
        validationCalls += 1;
        if (validationCalls === 1) {
          firstValidationEntered?.();
          await firstGate;
          return privyJson({ data: [] });
        }
        return privyJson({ data: [] });
      }
      if (url === PRIVY_EXTERNAL_WALLET_URL) return privyJson({ error: "not found" }, 404);
      if (init?.method === "POST") return privyWalletResponse();
      throw new Error(`Unexpected Privy request: ${url}`);
    });
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const stalePromise = installationRequest(app, token, "complete");
    await firstEntered;
    const staleToken = (await getState()).last_check_at;
    await getDb(env)
      .prepare("UPDATE custody_connections SET last_check_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", CONNECTION_ID)
      .run();

    const winner = await installationRequest(app, token, "complete");
    expect(winner.status).toBe(200);
    releaseFirstValidation?.();
    const stale = await stalePromise;

    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ data: { completion: { status: "success" } } });
    const state = await getState();
    expect(state.connection_status).toBe("active");
    expect(state.last_check_status).toBe("success");
    expect(state.last_check_at).not.toBe(staleToken);
    expect(
      await getDb(env).prepare("SELECT COUNT(*) AS count FROM custody_wallets").first()
    ).toEqual({ count: 1 });
  });

  it("returns the committed success when a stale completion later reports a conflict", async () => {
    let firstLookupEntered: (() => void) | undefined;
    let releaseFirstLookup: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      firstLookupEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstLookup = resolve;
    });
    let lookupCalls = 0;
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/wallets?limit=1&chain_type=solana")) {
        return privyJson({ data: [] });
      }
      if (url === PRIVY_EXTERNAL_WALLET_URL) {
        lookupCalls += 1;
        if (lookupCalls === 1) {
          firstLookupEntered?.();
          await firstGate;
          return privyJson({
            id: PRIVY_WALLET_ID,
            address: PRIVY_WALLET_ADDRESS,
            chain_type: "solana",
            external_id: PRIVY_EXTERNAL_ID,
            archived_at: Date.now(),
          });
        }
        return privyJson({ error: "not found" }, 404);
      }
      if (init?.method === "POST") return privyWalletResponse();
      throw new Error(`Unexpected Privy request: ${url}`);
    });
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const stalePromise = installationRequest(app, token, "complete");
    await firstEntered;
    await getDb(env)
      .prepare("UPDATE custody_connections SET last_check_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", CONNECTION_ID)
      .run();

    const winner = await installationRequest(app, token, "complete");
    expect(winner.status).toBe(200);
    releaseFirstLookup?.();
    const stale = await stalePromise;

    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ data: { completion: { status: "success" } } });
    expect(await getState()).toMatchObject({
      credential_status: "active",
      connection_status: "active",
      last_check_status: "success",
    });
  });

  it("fails a duplicate live Privy account in the same Project before wallet creation", async () => {
    await seedActiveFingerprintConnection();
    const providerFetch = vi.fn().mockResolvedValue(privyJson({ data: [] }));
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const response = await installationRequest(app, token, "complete");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        details: { reason: "provider_account_already_connected" },
      },
    });
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(providerFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(await getState()).toMatchObject({
      credential_status: "failed_validation",
      encrypted_secret_payload: null,
      connection_status: "failed",
      provider_account_fingerprint: null,
      last_check_status: "failed",
      last_check_failure_code: "provider_account_already_connected",
    });
  });

  it("allows the same Privy account fingerprint in another Project", async () => {
    const otherProjectId = "prj_provider_credential_installation_other";
    await seedProject(otherProjectId, "provider-credential-installation-other");
    await seedActiveFingerprintConnection({
      projectId: otherProjectId,
      credentialId: "pcred_existing_privy_other_project",
      connectionId: "cconn_existing_privy_other_project",
    });
    successfulPrivyFetch();
    const { app, token } = buildApp();

    const response = await installationRequest(app, token, "complete");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { completion: { status: "success" } } });
    expect(await getState()).toMatchObject({
      connection_status: "active",
      provider_account_fingerprint: PROVIDER_ACCOUNT_FINGERPRINT,
    });
  });

  it("returns only the safe exact projection and treats an expired lease as retry_unknown", async () => {
    const { app, token } = buildApp();

    const pending = await getInstallation(app, token);

    expect(pending.status).toBe(200);
    const pendingBody = await pending.json();
    expect(pendingBody).toMatchObject({
      data: {
        connection: {
          id: CONNECTION_ID,
          provider: "privy",
          label: "Treasury Privy",
          status: "pending",
          completion: null,
          walletLabel: WALLET_LABEL,
          isDefault: false,
          canComplete: true,
          canReplaceCredentials: false,
          canCancel: true,
        },
      },
    });
    const serialized = JSON.stringify(pendingBody);
    expect(serialized).not.toContain(CREDENTIAL_ID);
    expect(serialized).not.toContain(APP_ID);
    expect(serialized).not.toContain(APP_SECRET);
    expect(serialized).not.toContain("provider_account_fingerprint");
    expect(serialized).not.toContain("last_check_failure_code");

    const expiredToken = "2000-01-01T00:00:00.000Z";
    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'checking', last_check_status = 'running', last_check_at = ?
         WHERE id = ?`
      )
      .bind(expiredToken, CONNECTION_ID)
      .run();
    const expired = await getInstallation(app, token);

    expect(expired.status).toBe(200);
    expect(await expired.json()).toMatchObject({
      data: {
        connection: {
          status: "checking",
          completion: { status: "retry_unknown", attemptedAt: expiredToken },
          canComplete: true,
          canReplaceCredentials: false,
          canCancel: true,
        },
      },
    });
  });

  it("does not enumerate Connections across Projects or before authentication", async () => {
    const otherProjectId = "prj_provider_credential_installation_hidden";
    const otherConnectionId = "cconn_provider_credential_installation_hidden";
    await seedProject(otherProjectId, "provider-credential-installation-hidden");
    await seedPendingInstallation({
      projectId: otherProjectId,
      credentialId: "pcred_provider_credential_installation_hidden",
      connectionId: otherConnectionId,
    });
    const { app, token } = buildApp();

    const hidden = await getInstallation(app, token, { connectionId: otherConnectionId });
    const missing = await getInstallation(app, token, { connectionId: "cconn_missing" });

    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

    const unauthenticated = buildApp({ injectJwt: false });
    const unauthenticatedExisting = await getInstallation(
      unauthenticated.app,
      unauthenticated.token
    );
    const unauthenticatedMissing = await getInstallation(
      unauthenticated.app,
      unauthenticated.token,
      {
        connectionId: "cconn_missing",
      }
    );
    expect(unauthenticatedExisting.status).toBe(401);
    expect(unauthenticatedMissing.status).toBe(401);
  });

  it("cancels a pre-fingerprint installation flag-off without Provider I/O and is idempotent", async () => {
    env.PRIVY_BYOK_ENABLED = "false";
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const [canceled, replay] = await Promise.all([
      installationRequest(app, token, "cancel"),
      installationRequest(app, token, "cancel"),
    ]);

    expect(canceled.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await canceled.json()).toMatchObject({
      data: {
        connection: {
          id: CONNECTION_ID,
          status: "deactivated",
          canComplete: false,
          canReplaceCredentials: false,
          canCancel: false,
        },
      },
    });
    expect(await replay.json()).toMatchObject({
      data: { connection: { id: CONNECTION_ID, status: "deactivated" } },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await getState()).toMatchObject({
      credential_status: "deactivated",
      encrypted_secret_payload: null,
      connection_status: "deactivated",
      provider_account_fingerprint: null,
      default_custody_wallet_id: null,
      deactivated_at: expect.any(String),
    });
  });

  it("keeps cancellation successful and replayable when its audit outcome cannot be persisted", async () => {
    env.PRIVY_BYOK_ENABLED = "false";
    const completeCritical = vi
      .spyOn(AuditService.prototype, "completeCritical")
      .mockResolvedValue(false);
    const { app, token } = buildApp();

    const canceled = await installationRequest(app, token, "cancel");
    const replay = await installationRequest(app, token, "cancel");

    expect(canceled.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(completeCritical).toHaveBeenCalledOnce();
    expect(await getState()).toMatchObject({
      credential_status: "deactivated",
      connection_status: "deactivated",
      default_custody_wallet_id: null,
    });
  });

  it("keeps cancellation replayable after a lost COMMIT response", async () => {
    env.PRIVY_BYOK_ENABLED = "false";
    const db = getDb(env);
    const runTransaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(async (callback) => {
      await runTransaction(callback);
      throw new Error("simulated lost COMMIT response");
    });
    const { app, token } = buildApp();

    const response = await installationRequest(app, token, "cancel");

    expect(response.status).toBe(200);
    expect(await getState()).toMatchObject({
      credential_status: "deactivated",
      connection_status: "deactivated",
    });
    const audit = await db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_logs
         WHERE action = 'deactivate' AND resource_id = ?`
      )
      .bind(CONNECTION_ID)
      .first<{ count: number }>();
    expect(audit?.count).toBe(0);
  });

  it("blocks cancel during a current lease or after fingerprint reservation", async () => {
    const { app, token } = buildApp();
    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'checking', last_check_status = 'running', last_check_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(CONNECTION_ID)
      .run();

    const currentLease = await installationRequest(app, token, "cancel");

    expect(currentLease.status).toBe(409);
    expect(await currentLease.json()).toMatchObject({
      error: { details: { reason: "completion_in_progress" } },
    });

    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'pending', last_check_status = 'retry_unknown',
             last_check_at = sdp_iso_now(), provider_account_fingerprint = ?
         WHERE id = ?`
      )
      .bind(PROVIDER_ACCOUNT_FINGERPRINT, CONNECTION_ID)
      .run();
    const fingerprinted = await installationRequest(app, token, "cancel");

    expect(fingerprinted.status).toBe(409);
    expect(await fingerprinted.json()).toMatchObject({
      error: { details: { reason: "installation_completion_required" } },
    });
    expect((await getState()).connection_status).toBe("pending");
  });

  it("allows cancel after a pre-fingerprint completion lease expires", async () => {
    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'checking', last_check_status = 'running',
             last_check_at = '2000-01-01T00:00:00.000Z'
         WHERE id = ?`
      )
      .bind(CONNECTION_ID)
      .run();
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const response = await installationRequest(app, token, "cancel");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        connection: {
          id: CONNECTION_ID,
          status: "deactivated",
          completion: { status: "retry_unknown" },
        },
      },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await getState()).toMatchObject({
      credential_status: "deactivated",
      connection_status: "deactivated",
      last_check_status: "retry_unknown",
      encrypted_secret_payload: null,
    });
  });
});
