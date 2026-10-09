import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { verifyClerkJwt } from "@/lib/clerk-token";
import { getPrivyProviderAccountFingerprint } from "@/services/custody/privy-credential";
import { ProviderCredentialStore } from "@/services/stores/provider-credential.store";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import {
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
  seedTestPrivyConnection,
  type TestStoredProviderCredential,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

const ORGANIZATION_ID = "org_byok_release_channel";
const PROJECT_ID = "prj_byok_release_channel";
const USER_ID = "usr_byok_release_channel";
const CREDENTIAL_ID = "pcred_byok_release_channel";
const SUCCESSOR_CREDENTIAL_ID = "pcred_byok_release_channel_successor";
const CONNECTION_ID = "cconn_byok_release_channel";
const CUSTODY_WALLET_ID = "cwlt_byok_release_channel_installed";
const SEEDED_AT = "2026-01-01T00:00:00.000Z";
const APP_ID = "privy-app-1234";
const APP_SECRET = "exact secret";
const PRIVY_API_BASE_URL = "https://privy.byok-release-channel.test/v1";
const CHANNEL_REFUSAL = {
  code: "FORBIDDEN",
  message: "The privy custody provider is not available in this release channel for byok custody.",
  details: { reason: "custody_provider_not_in_release_channel" },
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

async function storedCredential(
  status: TestStoredProviderCredential["status"]
): Promise<TestStoredProviderCredential> {
  return {
    id: CREDENTIAL_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    label: "Treasury Privy",
    stored: await writeTestPrivyCredentialSecret(env, {
      organizationId: ORGANIZATION_ID,
      credentialId: CREDENTIAL_ID,
      appId: APP_ID,
      appSecret: APP_SECRET,
    }),
    displayMetadata: { appIdSuffix: "1234" },
    status,
    credentialVersion: 1,
    rotatedFromProviderCredentialId: null,
    lastValidatedAt: null,
    deactivatedAt: null,
    createdBy: USER_ID,
  };
}

async function seedPendingInstallation(providerAccountFingerprint: string | null): Promise<void> {
  const db = getDb(env);
  const credential = await storedCredential("pending");
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

async function seedActiveConnection(): Promise<void> {
  const providerAccountFingerprint = await getPrivyProviderAccountFingerprint(APP_ID);
  await getDb(env).transaction(async (tx) => {
    await seedTestPrivyConnection(tx, {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      connectionId: CONNECTION_ID,
      credentialId: CREDENTIAL_ID,
      createdBy: USER_ID,
      stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "byok-channel-ciphertext" },
      providerAccountFingerprint,
      lastCheckStatus: "success",
      wallets: [
        {
          id: CUSTODY_WALLET_ID,
          walletId: "privy_byok_release_channel_installed",
          publicKey: "byok-release-channel-installed-address",
          label: null,
          purpose: null,
          status: "active",
        },
      ],
      defaultCustodyWalletId: CUSTODY_WALLET_ID,
    });
  });
}

async function seedTornDownConnection(): Promise<void> {
  const db = getDb(env);
  const credential = await storedCredential("active");
  await insertTestStoredProviderCredential(db, credential);
  await insertTestCustodyConnection(db, {
    id: CONNECTION_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    credential,
    status: "deactivated",
    setupMetadata: {},
    providerAccountFingerprint: await getPrivyProviderAccountFingerprint(APP_ID),
    lastCheckStatus: "success",
    lastCheckAt: SEEDED_AT,
    lastCheckFailureCode: null,
    activatedAt: SEEDED_AT,
    deactivatedAt: SEEDED_AT,
    createdBy: USER_ID,
    createdAt: SEEDED_AT,
  });
}

async function seedSuccessor(
  lifecycle: Pick<TestStoredProviderCredential, "status" | "deactivatedAt">
): Promise<void> {
  await insertTestStoredProviderCredential(getDb(env), {
    id: SUCCESSOR_CREDENTIAL_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    label: "Privy",
    stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "byok-channel-successor" },
    displayMetadata: {},
    status: lifecycle.status,
    credentialVersion: 2,
    rotatedFromProviderCredentialId: CREDENTIAL_ID,
    lastValidatedAt: null,
    deactivatedAt: lifecycle.deactivatedAt,
    createdBy: USER_ID,
  });
}

async function seedFailedCandidate(): Promise<void> {
  await seedSuccessor({ status: "pending", deactivatedAt: null });
  expect(
    await new ProviderCredentialStore(getDb(env)).recordRotationFailure(
      SUCCESSOR_CREDENTIAL_ID,
      "invalid_credentials"
    )
  ).toBe(true);
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
  return required(counts);
}

async function credentialState() {
  return getDb(env).queryMany("SELECT * FROM provider_credentials ORDER BY id");
}

async function connectionState() {
  return getDb(env).queryOne(
    `SELECT status, last_check_status, last_check_at, provider_account_fingerprint
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
  const providerFetch = vi.fn<typeof fetch>();

  beforeEach(async () => {
    custodyReleaseChannel.outOfChannelMode = "byok";
    await seedTestDatabase(env);
    await clearKVStores(env);
    env.CREDENTIAL_SECRET_STORE_BACKEND = "encrypted_db";
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    env.CREDENTIAL_FINGERPRINT_PEPPER = "byok-release-channel-fingerprint-pepper";
    env.PRIVY_API_BASE_URL = PRIVY_API_BASE_URL;
    await seedActor();
    clerkToken = await signSeededClerkMember(env, getDb(env), USER_ID, ORGANIZATION_ID);
    await verifyClerkJwt(clerkToken, env);
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
    const response = await submit("byok-out-first-submission");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: CHANNEL_REFUSAL,
      meta: { requestId: expect.any(String) },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await domainCounts()).toEqual({ credentials: 0, connections: 0, wallets: 0 });
  });

  it("replays an identical earlier submission and refuses a new key", async () => {
    custodyReleaseChannel.outOfChannelMode = null;
    const first = await submit("byok-out-replay");
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: Record<string, unknown> };
    custodyReleaseChannel.outOfChannelMode = "byok";

    const replay = await submit("byok-out-replay");
    const fresh = await submit("byok-out-new-key");

    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({
      data: firstBody.data,
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(fresh.status).toBe(403);
    expect(await fresh.json()).toEqual({
      error: CHANNEL_REFUSAL,
      meta: { requestId: expect.any(String) },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await domainCounts()).toEqual({ credentials: 1, connections: 1, wallets: 0 });
  });

  it("refuses completing a pre-fingerprint installation without secret or Provider access", async () => {
    await seedPendingInstallation(null);
    const before = await connectionState();

    const response = await dashboardRequest(
      `/internal/dashboard/custody/connections/${CONNECTION_ID}/complete`,
      { method: "POST", idempotencyKey: null, body: null }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: CHANNEL_REFUSAL,
      meta: { requestId: expect.any(String) },
    });
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
    const [providerUrl, providerInit] = required(providerFetch.mock.calls[0]);
    expect(providerUrl).toBe(`${PRIVY_API_BASE_URL}/wallets/ext_wal_sdp_${CONNECTION_ID}`);
    expect(providerInit).toMatchObject({ method: "GET" });
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
    await seedActiveConnection();
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

  it.each([
    {
      operation: "rollback",
      state: "a retired Credential",
      seed: () => seedSuccessor({ status: "retired", deactivatedAt: null }),
      path: `/internal/dashboard/custody/provider-credentials/${SUCCESSOR_CREDENTIAL_ID}/rollback`,
      idempotencyKey: null,
      body: null,
    },
    {
      operation: "rotate",
      state: "a deactivated Credential",
      seed: () => seedSuccessor({ status: "deactivated", deactivatedAt: SEEDED_AT }),
      path: `/internal/dashboard/custody/provider-credentials/${SUCCESSOR_CREDENTIAL_ID}/rotate`,
      idempotencyKey: "byok-out-rotate-deactivated",
      body: { fields: { appId: APP_ID, appSecret: "rotated secret" } },
    },
    {
      operation: "complete-rotation",
      state: "a failed rotation candidate",
      seed: seedFailedCandidate,
      path: `/internal/dashboard/custody/provider-credentials/${SUCCESSOR_CREDENTIAL_ID}/complete-rotation`,
      idempotencyKey: null,
      body: null,
    },
  ])(
    "refuses $operation on $state before its state check",
    async ({ seed, path, idempotencyKey, body }) => {
      await seedActiveConnection();
      await seed();
      const before = await credentialState();

      const response = await dashboardRequest(path, { method: "POST", idempotencyKey, body });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: CHANNEL_REFUSAL,
        meta: { requestId: expect.any(String) },
      });
      expect(providerFetch).not.toHaveBeenCalled();
      expect(await credentialState()).toEqual(before);
    }
  );

  it("deactivates a Credential whose Connection is torn down", async () => {
    await seedTornDownConnection();
    const [before] = await credentialState();

    const response = await dashboardRequest(
      `/internal/dashboard/custody/provider-credentials/${CREDENTIAL_ID}/deactivate`,
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
          status: "deactivated",
          createdAt: expect.any(String),
          displayMetadata: { appIdSuffix: "1234" },
        },
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await credentialState()).toEqual([
      {
        ...required(before),
        status: "deactivated",
        encrypted_secret_payload: null,
        deactivated_at: expect.any(String),
        updated_at: expect.any(String),
      },
    ]);
  });

  it("lists an active Connection as not runtime-executable", async () => {
    await seedActiveConnection();

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
            label: "Privy",
            status: "active",
            isRuntimeExecutionAllowed: false,
            createdAt: expect.any(String),
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
});
