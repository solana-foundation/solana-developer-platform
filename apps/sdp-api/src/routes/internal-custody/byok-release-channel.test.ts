import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import * as credentialSecretStore from "@/services/credential-secret-store";
import { getPrivyProviderAccountFingerprint } from "@/services/custody/privy-credential";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import {
  activateTestCustodyConnection,
  insertTestConnectionWallet,
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
  selectTestCustodyConnection,
  type TestStoredProviderCredential,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const custodyStage = vi.hoisted(() => ({ privyByokInChannel: false }));

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const original = await importOriginal<typeof import("@sdp/types/release-channels")>();
  return {
    ...original,
    isCustodyProviderInReleaseChannel: (
      ...args: Parameters<typeof original.isCustodyProviderInReleaseChannel>
    ) => {
      const [, provider, mode] = args;
      return (
        (custodyStage.privyByokInChannel || !(provider === "privy" && mode === "byok")) &&
        original.isCustodyProviderInReleaseChannel(...args)
      );
    },
  };
});

const ORGANIZATION_ID = "org_byok_release_channel";
const PROJECT_ID = "prj_byok_release_channel";
const USER_ID = "usr_byok_release_channel";
const CREDENTIAL_ID = "pcred_byok_release_channel";
const CONNECTION_ID = "cconn_byok_release_channel";
const DEFAULT_CUSTODY_WALLET_ID = "cwlt_byok_release_channel_default";
const OTHER_CUSTODY_WALLET_ID = "cwlt_byok_release_channel_other";
const OTHER_WALLET_ID = "privy_byok_release_channel_other";
const SEEDED_AT = "2026-01-01T00:00:00.000Z";
const APP_ID = "privy-app-1234";
const APP_SECRET = "exact secret";
const PRIVY_API_BASE_URL = "https://privy.byok-release-channel.test/v1";
const CHANNEL_REFUSAL = {
  code: "FORBIDDEN",
  message: "The privy custody provider is not available in this release channel for byok custody.",
};
const VALID_BODY = {
  provider: "privy",
  fields: {
    credentialLabel: "Treasury Privy",
    scope: "project",
    appId: APP_ID,
    appSecret: APP_SECRET,
  },
} as const;

let clerkToken: string;

async function seedActor(): Promise<void> {
  const db = getDb(env);
  await db.execute(
    `INSERT INTO organizations (id, name, slug, tier, status)
     VALUES (?, 'BYOK Release Channel', 'byok-release-channel', 'individual', 'active')`,
    [ORGANIZATION_ID]
  );
  await db.execute(
    `INSERT INTO users (id, email, email_verified, status)
     VALUES (?, 'byok-release-channel@example.com', 1, 'active')`,
    [USER_ID]
  );
  await db.execute(
    `INSERT INTO organization_members (id, organization_id, user_id, role, status)
     VALUES ('mem_byok_release_channel', ?, ?, 'admin', 'active')`,
    [ORGANIZATION_ID, USER_ID]
  );
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [USER_ID],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
}

function credentialRow(input: {
  status: "pending" | "active";
  stored: TestStoredProviderCredential["stored"];
}): TestStoredProviderCredential {
  return {
    id: CREDENTIAL_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    label: "Treasury Privy",
    stored: input.stored,
    displayMetadata: { appIdSuffix: "1234" },
    status: input.status,
    credentialVersion: 1,
    rotatedFromProviderCredentialId: null,
    lastValidatedAt: null,
    deactivatedAt: null,
    createdBy: USER_ID,
  };
}

async function seedPendingInstallation(providerAccountFingerprint: string | null): Promise<void> {
  const stored = await credentialSecretStore.createCredentialSecretStore(env).write({
    orgId: ORGANIZATION_ID,
    provider: "privy",
    providerCredentialId: CREDENTIAL_ID,
    payload: { appId: APP_ID, appSecret: APP_SECRET },
  });
  const db = getDb(env);
  const credential = credentialRow({ status: "pending", stored });
  await insertTestStoredProviderCredential(db, credential);
  await insertTestCustodyConnection(db, {
    id: CONNECTION_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    credential,
    status: "pending",
    setupMetadata: {},
    providerAccountFingerprint,
    lastCheckStatus: null,
    lastCheckAt: null,
    lastCheckFailureCode: null,
    activatedAt: null,
    deactivatedAt: null,
    createdBy: USER_ID,
    createdAt: SEEDED_AT,
  });
}

async function seedSelectedActiveConnection(): Promise<void> {
  const db = getDb(env);
  const credential = credentialRow({
    status: "active",
    stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "byok-channel-ciphertext" },
  });
  await insertTestStoredProviderCredential(db, credential);
  await insertTestCustodyConnection(db, {
    id: CONNECTION_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    credential,
    status: "pending",
    setupMetadata: {},
    providerAccountFingerprint: null,
    lastCheckStatus: null,
    lastCheckAt: null,
    lastCheckFailureCode: null,
    activatedAt: null,
    deactivatedAt: null,
    createdBy: USER_ID,
    createdAt: SEEDED_AT,
  });
  await insertTestConnectionWallet(db, {
    id: DEFAULT_CUSTODY_WALLET_ID,
    connectionId: CONNECTION_ID,
    walletId: "privy_byok_release_channel_default",
    publicKey: "byok-release-channel-default-address",
    status: "active",
  });
  await insertTestConnectionWallet(db, {
    id: OTHER_CUSTODY_WALLET_ID,
    connectionId: CONNECTION_ID,
    walletId: OTHER_WALLET_ID,
    publicKey: "byok-release-channel-other-address",
    status: "active",
  });
  await activateTestCustodyConnection(db, {
    connectionId: CONNECTION_ID,
    custodyWalletId: DEFAULT_CUSTODY_WALLET_ID,
    providerAccountFingerprint: await getPrivyProviderAccountFingerprint(APP_ID),
  });
  await selectTestCustodyConnection(db, {
    id: "csd_byok_release_channel",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    connectionId: CONNECTION_ID,
  });
}

function dashboardRequest(
  path: string,
  options: { method: "GET" | "POST"; idempotencyKey: string | null; body: unknown }
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${clerkToken}`,
    "Content-Type": "application/json",
    "X-Project-ID": PROJECT_ID,
  };
  if (options.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  return Promise.resolve(
    app.request(
      path,
      {
        method: options.method,
        headers,
        ...(options.body === null ? {} : { body: JSON.stringify(options.body) }),
      },
      env
    )
  );
}

function submit(idempotencyKey: string): Promise<Response> {
  return dashboardRequest("/internal/dashboard/custody/provider-credentials", {
    method: "POST",
    idempotencyKey,
    body: VALID_BODY,
  });
}

async function domainCounts(): Promise<{
  credentials: number;
  connections: number;
  wallets: number;
}> {
  const counts = await getDb(env).queryOne<{
    credentials: number;
    connections: number;
    wallets: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM provider_credentials) AS credentials,
       (SELECT COUNT(*)::int FROM custody_connections) AS connections,
       (SELECT COUNT(*)::int FROM custody_wallets) AS wallets`
  );
  if (!counts) throw new Error("Domain count query returned no row");
  return counts;
}

async function credentialState() {
  return getDb(env).queryMany("SELECT * FROM provider_credentials ORDER BY id");
}

async function connectionState() {
  return getDb(env).queryOne(
    `SELECT status, last_check_status, last_check_at, provider_account_fingerprint,
            default_custody_wallet_id
     FROM custody_connections WHERE id = ?`,
    [CONNECTION_ID]
  );
}

describe("BYOK Privy outside the release channel", () => {
  const original = {
    backend: env.CREDENTIAL_SECRET_STORE_BACKEND,
    encryptionKey: env.CUSTODY_ENCRYPTION_KEY,
    fingerprintPepper: env.CREDENTIAL_FINGERPRINT_PEPPER,
    privyApiBaseUrl: env.PRIVY_API_BASE_URL,
  };
  const providerFetch = vi.fn();

  beforeEach(async () => {
    custodyStage.privyByokInChannel = false;
    await seedTestDatabase(env);
    await clearKVStores(env);
    env.CREDENTIAL_SECRET_STORE_BACKEND = "encrypted_db";
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    env.CREDENTIAL_FINGERPRINT_PEPPER = "byok-release-channel-fingerprint-pepper";
    env.PRIVY_API_BASE_URL = PRIVY_API_BASE_URL;
    await seedActor();
    clerkToken = await signSeededClerkMember(env, getDb(env), USER_ID, ORGANIZATION_ID);
    providerFetch.mockReset();
    vi.stubGlobal("fetch", providerFetch);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    env.CREDENTIAL_SECRET_STORE_BACKEND = original.backend;
    env.CUSTODY_ENCRYPTION_KEY = original.encryptionKey;
    env.CREDENTIAL_FINGERPRINT_PEPPER = original.fingerprintPepper;
    env.PRIVY_API_BASE_URL = original.privyApiBaseUrl;
    await clearKVStores(env);
  });

  it("refuses a first submission before any secret or domain write", async () => {
    const secretFactory = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");

    const response = await submit("byok-out-first-submission");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Custody Connection setup is disabled for this provider",
      },
      meta: { requestId: expect.any(String) },
    });
    expect(secretFactory).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await domainCounts()).toEqual({ credentials: 0, connections: 0, wallets: 0 });
  });

  it("replays an identical earlier submission and refuses a new key", async () => {
    custodyStage.privyByokInChannel = true;
    const first = await submit("byok-out-replay");
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: Record<string, unknown> };
    custodyStage.privyByokInChannel = false;

    const replay = await submit("byok-out-replay");
    const fresh = await submit("byok-out-new-key");

    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({
      data: firstBody.data,
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(fresh.status).toBe(403);
    expect(await fresh.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Custody Connection setup is disabled for this provider",
      },
      meta: { requestId: expect.any(String) },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await domainCounts()).toEqual({ credentials: 1, connections: 1, wallets: 0 });
  });

  it("refuses completing a pre-fingerprint installation without secret or Provider access", async () => {
    await seedPendingInstallation(null);
    const before = await connectionState();
    const secretFactory = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");

    const response = await dashboardRequest(
      `/internal/dashboard/custody/connections/${CONNECTION_ID}/complete`,
      { method: "POST", idempotencyKey: null, body: null }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Provider credential installation is unavailable" },
      meta: { requestId: expect.any(String) },
    });
    expect(secretFactory).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await connectionState()).toEqual(before);
  });

  it("reconciles a pinned installation by Provider GET only", async () => {
    await seedPendingInstallation(await getPrivyProviderAccountFingerprint(APP_ID));
    providerFetch.mockResolvedValueOnce(
      Response.json({
        id: "wallet-byok-release-channel",
        address: "wallet-address-byok-release-channel",
        chain_type: "solana",
        external_id: `sdp_${CONNECTION_ID}`,
      })
    );

    const response = await dashboardRequest(
      `/internal/dashboard/custody/connections/${CONNECTION_ID}/complete`,
      { method: "POST", idempotencyKey: null, body: null }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
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
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(providerFetch.mock.calls[0]?.[0]).toBe(
      `${PRIVY_API_BASE_URL}/wallets/ext_wal_sdp_${CONNECTION_ID}`
    );
    expect(providerFetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it.each([
    {
      operation: "rotate",
      path: `/internal/dashboard/custody/provider-credentials/${CREDENTIAL_ID}/rotate`,
      idempotencyKey: "byok-out-rotate",
      body: { fields: { appId: APP_ID, appSecret: "rotated secret" } },
    },
    {
      operation: "complete-rotation",
      path: `/internal/dashboard/custody/provider-credentials/${CREDENTIAL_ID}/complete-rotation`,
      idempotencyKey: null,
      body: null,
    },
    {
      operation: "rollback",
      path: `/internal/dashboard/custody/provider-credentials/${CREDENTIAL_ID}/rollback`,
      idempotencyKey: null,
      body: null,
    },
  ])("refuses $operation before any Provider call", async ({ path, idempotencyKey, body }) => {
    await seedSelectedActiveConnection();
    const before = await credentialState();

    const response = await dashboardRequest(path, { method: "POST", idempotencyKey, body });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: CHANNEL_REFUSAL,
      meta: { requestId: expect.any(String) },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await credentialState()).toEqual(before);
  });

  it("lists a selected Connection as neither default nor runtime-executable", async () => {
    await seedSelectedActiveConnection();

    const response = await dashboardRequest("/internal/dashboard/custody/connections", {
      method: "GET",
      idempotencyKey: null,
      body: null,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        connections: [
          {
            id: CONNECTION_ID,
            provider: "privy",
            label: "Treasury Privy",
            status: "active",
            isDefault: false,
            isRuntimeExecutionAllowed: false,
            defaultCustodyWalletId: DEFAULT_CUSTODY_WALLET_ID,
            createdAt: SEEDED_AT,
            activatedAt: expect.any(String),
            lastCheck: { status: "success", at: expect.any(String), failureCode: null },
            pendingWalletLabel: null,
          },
        ],
        pagination: { limit: 20, offset: 0, total: 1 },
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });

  it("refuses moving the Connection's default wallet", async () => {
    await seedSelectedActiveConnection();
    const before = await connectionState();

    const response = await dashboardRequest("/v1/wallets/default-wallet", {
      method: "POST",
      idempotencyKey: null,
      body: { walletId: OTHER_WALLET_ID },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: CHANNEL_REFUSAL,
      meta: { requestId: expect.any(String) },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await connectionState()).toEqual(before);
  });
});
