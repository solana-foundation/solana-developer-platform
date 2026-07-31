import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import * as credentialSecretStore from "@/services/credential-secret-store";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import internalCustody from "./index";

const ORGANIZATION_ID = "org_provider_credential_check";
const PROJECT_ID = "prj_provider_credential_check";
const USER_ID = "usr_provider_credential_check";
const CREDENTIAL_ID = "pcred_provider_credential_check";
const CONNECTION_ID = "cconn_provider_credential_check";
const APP_ID = "privy-app-1234";
const APP_SECRET = "exact secret";
const WALLET_LABEL = "Treasury Wallet";
const PRIVY_WALLET_ID = "wallet-provider-credential-check";
const PRIVY_WALLET_ADDRESS = "wallet-address-provider-credential-check";
const PRIVY_EXTERNAL_ID = `sdp_${CONNECTION_ID}`;
const PRIVY_IDEMPOTENCY_KEY = `sdp_install_${CONNECTION_ID}_${CREDENTIAL_ID}_initial`;

function privyJson(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function privyWalletResponse(overrides: Record<string, unknown> = {}): Response {
  return privyJson({
    id: PRIVY_WALLET_ID,
    address: PRIVY_WALLET_ADDRESS,
    chain_type: "solana",
    external_id: PRIVY_EXTERNAL_ID,
    ...overrides,
  });
}

function stubSuccessfulPrivyProvisioning() {
  const providerFetch = vi
    .fn()
    .mockResolvedValueOnce(privyJson({ data: [], next_cursor: null }))
    .mockResolvedValueOnce(privyJson({ data: [], next_cursor: null }))
    .mockResolvedValueOnce(privyWalletResponse());
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
    sub: "clerk_provider_credential_check",
    org_id: "clerk_org_provider_credential_check",
    org_role: "org:admin",
    email: "provider-credential-check@example.com",
  });
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", kvStoreMiddleware());
  app.use("*", async (c, next) => {
    if (options.injectJwt !== false) {
      c.set("verifiedClerkJwt", {
        token,
        payload: {
          sub: "clerk_provider_credential_check",
          org_id: "clerk_org_provider_credential_check",
          org_role: "org:admin",
          email: "provider-credential-check@example.com",
        },
      });
    }
    c.set("requestId", "req_provider_credential_check");
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
      .bind(ORGANIZATION_ID, "Provider Credential Check", "provider-credential-check"),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, ?, 1, 'active')`
      )
      .bind(USER_ID, "provider-credential-check@example.com"),
    db
      .prepare(
        `INSERT INTO auth_user_identities
           (id, provider, provider_user_id, user_id, email)
         VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind(
        "aui_provider_credential_check",
        "clerk_provider_credential_check",
        USER_ID,
        "provider-credential-check@example.com"
      ),
    db
      .prepare(
        `INSERT INTO auth_organization_identities
           (id, provider, provider_org_id, organization_id, slug)
         VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind(
        "aoi_provider_credential_check",
        "clerk_org_provider_credential_check",
        ORGANIZATION_ID,
        "provider-credential-check"
      ),
    db
      .prepare(
        `INSERT INTO organization_members
           (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'admin', 'active')`
      )
      .bind("mem_provider_credential_check", ORGANIZATION_ID, USER_ID),
    db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
      )
      .bind(
        PROJECT_ID,
        ORGANIZATION_ID,
        "Provider Credential Check",
        "provider-credential-check",
        USER_ID
      ),
    db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, 'admin')`
      )
      .bind("pm_provider_credential_check", PROJECT_ID, USER_ID),
  ]);
}

async function seedPendingCredential(): Promise<void> {
  const stored = await credentialSecretStore.createCredentialSecretStore(env).write({
    orgId: ORGANIZATION_ID,
    provider: "privy",
    providerCredentialId: CREDENTIAL_ID,
    payload: { appId: `  ${APP_ID}  `, appSecret: APP_SECRET },
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
        CREDENTIAL_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
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
        CONNECTION_ID,
        ORGANIZATION_ID,
        PROJECT_ID,
        CREDENTIAL_ID,
        PROJECT_ID,
        JSON.stringify({ pendingWalletLabel: WALLET_LABEL }),
        USER_ID
      ),
  ]);
}

async function check(
  app: Hono<{ Bindings: Env }>,
  token: string,
  credentialId = CREDENTIAL_ID
): Promise<Response> {
  return app.request(
    `/internal/dashboard/custody/provider-credentials/${credentialId}/check`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Project-ID": PROJECT_ID,
      },
    },
    env
  );
}

async function getCheckState(): Promise<{
  credential_status: string;
  encrypted_secret_payload: string | null;
  connection_status: string;
  setup_metadata: Record<string, unknown>;
  last_check_status: string | null;
  last_check_at: string | null;
  last_check_failure_code: string | null;
}> {
  const state = await getDb(env)
    .prepare(
      `SELECT pc.status AS credential_status, pc.encrypted_secret_payload,
              c.status AS connection_status, c.setup_metadata,
              c.last_check_status, c.last_check_at, c.last_check_failure_code
       FROM provider_credentials pc
       JOIN custody_connections c ON c.provider_credential_id = pc.id
       WHERE pc.id = ?`
    )
    .bind(CREDENTIAL_ID)
    .first<{
      credential_status: string;
      encrypted_secret_payload: string | null;
      connection_status: string;
      setup_metadata: Record<string, unknown>;
      last_check_status: string | null;
      last_check_at: string | null;
      last_check_failure_code: string | null;
    }>();
  if (!state) {
    throw new Error("Install Check state not found");
  }
  return state;
}

describe("POST /internal/dashboard/custody/provider-credentials/:id/check", () => {
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
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.CREDENTIAL_SECRET_STORE_BACKEND = "encrypted_db";
    env.CUSTODY_ENCRYPTION_KEY = testEncryptionKey();
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = undefined;
    env.PRIVY_APP_SECRET = undefined;
    env.PRIVY_API_BASE_URL = "https://privy.example.test/v1";
    await seedActor();
    await seedPendingCredential();
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
    await clearTestDatabase(env);
    await clearKVStores(env);
  });

  it("validates the exact stored credential, provisions one wallet, and activates its Connection", async () => {
    const providerFetch = stubSuccessfulPrivyProvisioning();
    const { app, token } = buildApp();

    const response = await check(app, token);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
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
        check: {
          status: "success",
          checkedAt: expect.any(String),
        },
      },
      meta: {
        requestId: "req_provider_credential_check",
        timestamp: expect.any(String),
      },
    });
    expect(JSON.stringify(body)).not.toContain(APP_ID);
    expect(JSON.stringify(body)).not.toContain(APP_SECRET);
    expect(JSON.stringify(body)).not.toContain(CONNECTION_ID);
    expect(providerFetch).toHaveBeenCalledTimes(3);
    expect(providerFetch.mock.calls[0]?.[0]).toBe(
      "https://privy.example.test/v1/wallets?limit=1&chain_type=solana"
    );
    expect(providerFetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64")}`,
        "privy-app-id": APP_ID,
      },
    });
    expect(providerFetch.mock.calls[1]?.[0]).toBe(
      `https://privy.example.test/v1/wallets?external_id=${PRIVY_EXTERNAL_ID}&limit=1&include_archived=true`
    );
    expect(providerFetch.mock.calls[2]).toEqual([
      "https://privy.example.test/v1/wallets",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "privy-idempotency-key": PRIVY_IDEMPOTENCY_KEY,
        }),
        body: JSON.stringify({
          chain_type: "solana",
          external_id: PRIVY_EXTERNAL_ID,
        }),
      }),
    ]);

    const state = await getDb(env)
      .prepare(
        `SELECT pc.status AS credential_status, pc.last_validated_at,
                c.status AS connection_status, c.setup_metadata,
                c.last_check_status, c.last_check_at, c.last_check_failure_code,
                c.default_custody_wallet_id,
                w.wallet_id, w.public_key, w.label AS wallet_label, w.custody_connection_id,
                d.default_custody_config_id, d.default_custody_connection_id,
                (SELECT COUNT(*) FROM custody_wallets) AS wallet_count,
                (SELECT COUNT(*) FROM custody_scope_defaults) AS default_count
         FROM provider_credentials pc
         JOIN custody_connections c ON c.provider_credential_id = pc.id
         LEFT JOIN custody_wallets w ON w.id = c.default_custody_wallet_id
         LEFT JOIN custody_scope_defaults d
           ON d.organization_id = c.organization_id
          AND d.project_id = c.project_id
         WHERE pc.id = ?`
      )
      .bind(CREDENTIAL_ID)
      .first<{
        credential_status: string;
        last_validated_at: string | null;
        connection_status: string;
        setup_metadata: Record<string, unknown>;
        last_check_status: string | null;
        last_check_at: string | null;
        last_check_failure_code: string | null;
        default_custody_wallet_id: string | null;
        wallet_id: string | null;
        public_key: string | null;
        wallet_label: string | null;
        custody_connection_id: string | null;
        default_custody_config_id: string | null;
        default_custody_connection_id: string | null;
        wallet_count: number;
        default_count: number;
      }>();
    expect(state).toMatchObject({
      credential_status: "active",
      last_validated_at: expect.any(String),
      connection_status: "active",
      setup_metadata: {
        providerAccountFingerprint:
          "sha256:227b73d3e3e9e6717d2c6f6500f88386b11130922ae7320de715a6ca237f3296",
      },
      last_check_status: "success",
      last_check_at: expect.any(String),
      last_check_failure_code: null,
      default_custody_wallet_id: expect.any(String),
      wallet_id: `privy_${PRIVY_WALLET_ID}`,
      public_key: PRIVY_WALLET_ADDRESS,
      wallet_label: WALLET_LABEL,
      custody_connection_id: CONNECTION_ID,
      default_custody_config_id: null,
      default_custody_connection_id: CONNECTION_ID,
      wallet_count: 1,
      default_count: 1,
    });
    expect(state?.setup_metadata).toEqual({
      providerAccountFingerprint:
        "sha256:227b73d3e3e9e6717d2c6f6500f88386b11130922ae7320de715a6ca237f3296",
    });
  });

  it("preserves the legacy Config default while selecting the checked Connection", async () => {
    const legacyConfigId = "cust_provider_credential_check_legacy";
    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          `INSERT INTO custody_configs (
             id, organization_id, project_id, provider, config_encrypted,
             encryption_version, status
           ) VALUES (?, ?, ?, 'privy', 'legacy', 'test', 'active')`
        )
        .bind(legacyConfigId, ORGANIZATION_ID, PROJECT_ID),
      db
        .prepare(
          `INSERT INTO custody_scope_defaults (
             id, organization_id, project_id, default_custody_config_id
           ) VALUES ('csd_provider_credential_check_legacy', ?, ?, ?)`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID, legacyConfigId),
    ]);
    stubSuccessfulPrivyProvisioning();
    const { app, token } = buildApp();

    const response = await check(app, token);

    expect(response.status).toBe(200);
    expect(
      await db
        .prepare(
          `SELECT default_custody_config_id, default_custody_connection_id
           FROM custody_scope_defaults
           WHERE organization_id = ? AND project_id = ?`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID)
        .first()
    ).toEqual({
      default_custody_config_id: legacyConfigId,
      default_custody_connection_id: CONNECTION_ID,
    });
  });

  it("keeps setup pending when wallet creation fails and reconciliation finds nothing", async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(privyJson({ data: [] }))
      .mockResolvedValueOnce(privyJson({ data: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(privyJson({ data: [] }));
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const response = await check(app, token);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        providerCredential: {
          id: CREDENTIAL_ID,
          status: "pending",
        },
        check: {
          status: "retry_unknown",
          checkedAt: expect.any(String),
        },
      },
    });
    expect(providerFetch).toHaveBeenCalledTimes(4);
    expect(providerFetch.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(await getCheckState()).toMatchObject({
      credential_status: "pending",
      connection_status: "pending",
      last_check_status: "retry_unknown",
      last_check_failure_code: "provider_response_unknown",
    });
    expect(
      await getDb(env)
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM custody_wallets) AS wallets,
             (SELECT COUNT(*) FROM custody_scope_defaults) AS defaults`
        )
        .first()
    ).toEqual({ wallets: 0, defaults: 0 });
  });

  it("returns a safe conflict when the deterministic Privy wallet cannot be reused", async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(privyJson({ data: [] }))
      .mockResolvedValueOnce(
        privyJson({
          data: [
            {
              id: PRIVY_WALLET_ID,
              address: PRIVY_WALLET_ADDRESS,
              chain_type: "solana",
              external_id: PRIVY_EXTERNAL_ID,
              archived_at: Date.now(),
            },
          ],
        })
      );
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const response = await check(app, token);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        message: "Privy wallet cannot be reconciled",
      },
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(await getCheckState()).toMatchObject({
      credential_status: "pending",
      connection_status: "pending",
      last_check_status: null,
    });
  });

  it("replays a completed Install Check after rollback without another Provider call or wallet", async () => {
    const providerFetch = stubSuccessfulPrivyProvisioning();
    const { app, token } = buildApp();

    const first = await check(app, token);
    const firstBody = (await first.json()) as {
      data: { check: { checkedAt: string } };
    };
    env.PRIVY_BYOK_ENABLED = "false";
    providerFetch.mockClear();

    const replay = await check(app, token);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: {
        providerCredential: {
          id: CREDENTIAL_ID,
          status: "active",
        },
        check: {
          status: "success",
          checkedAt: firstBody.data.check.checkedAt,
        },
      },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(
      await getDb(env).prepare("SELECT COUNT(*) AS count FROM custody_wallets").first()
    ).toMatchObject({ count: 1 });
  });

  it("converges concurrent Checks on one provider wallet", async () => {
    let createCalls = 0;
    let releaseCreates: (() => void) | undefined;
    const bothCreatesStarted = new Promise<void>((resolve) => {
      releaseCreates = resolve;
    });
    const providerFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") {
        return privyJson({ data: [] });
      }

      createCalls += 1;
      if (createCalls === 2) {
        releaseCreates?.();
      }
      await bothCreatesStarted;
      return privyWalletResponse();
    });
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const responses = await Promise.all([check(app, token), check(app, token)]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(createCalls).toBe(2);
    expect(
      await getDb(env).prepare("SELECT COUNT(*) AS count FROM custody_wallets").first()
    ).toEqual({ count: 1 });
  });

  it("records a Privy 401 as a redacted failed check instead of caller authentication failure", async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValue(privyJson({ error: "raw provider detail" }, 401));
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const response = await check(app, token);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        providerCredential: {
          id: CREDENTIAL_ID,
          status: "failed_validation",
        },
        check: {
          status: "failed",
          checkedAt: expect.any(String),
        },
      },
    });
    expect(await getCheckState()).toMatchObject({
      credential_status: "failed_validation",
      encrypted_secret_payload: null,
      connection_status: "failed",
      setup_metadata: { pendingWalletLabel: WALLET_LABEL },
      last_check_status: "failed",
      last_check_at: expect.any(String),
      last_check_failure_code: "invalid_credentials",
    });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["Privy 403", () => Promise.resolve(new Response(null, { status: 403 }))],
    ["Privy 429", () => Promise.resolve(new Response(null, { status: 429 }))],
    ["Privy 500", () => Promise.resolve(new Response(null, { status: 500 }))],
    ["malformed Privy 200", () => Promise.resolve(privyJson({ wallets: [] }))],
    ["a network failure", () => Promise.reject(new Error("raw network detail"))],
  ])("keeps the setup retryable after %s", async (_label, providerResult) => {
    const providerFetch = vi.fn(providerResult);
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const response = await check(app, token);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      data: {
        providerCredential: {
          id: CREDENTIAL_ID,
          status: "pending",
        },
        check: {
          status: "retry_unknown",
          checkedAt: expect.any(String),
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("raw");
    expect(await getCheckState()).toMatchObject({
      credential_status: "pending",
      encrypted_secret_payload: expect.any(String),
      connection_status: "pending",
      setup_metadata: { pendingWalletLabel: WALLET_LABEL },
      last_check_status: "retry_unknown",
      last_check_at: expect.any(String),
      last_check_failure_code: "provider_response_unknown",
    });
  });

  it.each([
    [
      "the release flag is off",
      async () => {
        env.PRIVY_BYOK_ENABLED = "false";
      },
    ],
    [
      "the organization is not entitled",
      async () => {
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
      },
    ],
  ])("rejects before secret or Provider access when %s", async (_label, arrange) => {
    await arrange();
    const factory = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const response = await check(app, token);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: "Stored credential provisioning is disabled for this provider",
      },
    });
    expect(factory).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await getCheckState()).toMatchObject({
      credential_status: "pending",
      connection_status: "pending",
      last_check_status: null,
    });
  });

  it("returns 404 for an unknown or foreign credential without choosing another Connection", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const response = await check(app, token, "pcred_not_in_this_project");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: "Provider credential not found",
      },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await getCheckState()).toMatchObject({
      credential_status: "pending",
      connection_status: "pending",
      last_check_status: null,
    });
  });

  it("requires dashboard authentication before target resolution", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const { app } = buildApp({ injectJwt: false });

    const response = await app.request(
      `/internal/dashboard/custody/provider-credentials/${CREDENTIAL_ID}/check`,
      {
        method: "POST",
        headers: {
          "X-Project-ID": PROJECT_ID,
        },
      },
      env
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("requires an accessible Project before target resolution", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const response = await app.request(
      `/internal/dashboard/custody/provider-credentials/${CREDENTIAL_ID}/check`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Project-ID": "prj_not_accessible",
        },
      },
      env
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: "Requested project is not accessible",
      },
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous exact binding before secret or Provider access", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO custody_connections (
           id, organization_id, project_id, provider, scope,
           provider_credential_id, provider_credential_scope_key, status, created_by
         ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'pending', ?)`
      )
      .bind(
        "cconn_provider_credential_check_ambiguous",
        ORGANIZATION_ID,
        PROJECT_ID,
        CREDENTIAL_ID,
        PROJECT_ID,
        USER_ID
      )
      .run();
    const factory = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const response = await check(app, token);

    expect(response.status).toBe(409);
    expect(factory).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("rejects a non-pending current binding before secret or Provider access", async () => {
    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'failed', last_check_status = 'failed',
             last_check_at = sdp_iso_now(),
             last_check_failure_code = 'invalid_credentials'
         WHERE id = ?`
      )
      .bind(CONNECTION_ID)
      .run();
    const factory = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const response = await check(app, token);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        message: "Provider credential is not available for Install Check",
      },
    });
    expect(factory).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("discards a Provider result when the exact pending binding changes in flight", async () => {
    const providerFetch = vi.fn(async () => {
      await getDb(env)
        .prepare(
          `UPDATE custody_connections
           SET status = 'deactivated', deactivated_at = sdp_iso_now()
           WHERE id = ?`
        )
        .bind(CONNECTION_ID)
        .run();
      return privyJson({ data: [] });
    });
    vi.stubGlobal("fetch", providerFetch);
    const { app, token } = buildApp();

    const response = await check(app, token);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        message: "Provider credential is not available for Install Check",
      },
    });
    expect(await getCheckState()).toMatchObject({
      credential_status: "pending",
      connection_status: "deactivated",
      setup_metadata: { pendingWalletLabel: WALLET_LABEL },
      last_check_status: null,
    });
  });

  it("destroys only the rejected GCP secret version after the terminal commit", async () => {
    const secretRef = "projects/sdp-test/secrets/sdp-provider-credentials-check";
    const secretVersionRef = `${secretRef}/versions/7`;
    await getDb(env)
      .prepare(
        `UPDATE provider_credentials
         SET storage_backend = 'gcp_secret_manager',
             secret_ref = ?,
             secret_version_ref = ?,
             encrypted_secret_payload = NULL
         WHERE id = ?`
      )
      .bind(secretRef, secretVersionRef, CREDENTIAL_ID)
      .run();
    const destroyVersion = vi.fn().mockResolvedValue(undefined);
    const factory = vi.spyOn(credentialSecretStore, "createCredentialSecretStore").mockReturnValue({
      storageBackend: "gcp_secret_manager",
      write: vi.fn(),
      read: vi.fn().mockResolvedValue({ appId: APP_ID, appSecret: APP_SECRET }),
      destroyVersion,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const { app, token } = buildApp();

    const response = await check(app, token);

    expect(response.status).toBe(200);
    expect(factory).toHaveBeenCalledWith(env, "gcp_secret_manager");
    expect(destroyVersion).toHaveBeenCalledOnce();
    expect(destroyVersion).toHaveBeenCalledWith({ secretVersionRef });
    expect(await getCheckState()).toMatchObject({
      credential_status: "failed_validation",
      connection_status: "failed",
      last_check_status: "failed",
    });
  });
});
