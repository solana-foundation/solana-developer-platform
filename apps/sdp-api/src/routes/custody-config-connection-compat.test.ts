import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { custodyProviderNotInReleaseChannel } from "@/services/provider-availability.service";
import { insertTestCustodyConfigRow, insertTestCustodyWalletRow } from "@/test/helpers/custody";
import { seedTestPrivyConnection } from "@/test/helpers/custody-connections";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

const ORGANIZATION_ID = "org_custody_config_connection_compat";
const PROJECT_ID = "prj_custody_config_connection_compat";
const USER_ID = "usr_custody_config_connection_compat";
const CONFIG_ID = "cust_config_connection_compat";
const CONFIG_WALLET_ID = "para_config_connection_wallet";
const CREDENTIAL_ID = "pcred_config_connection_compat";
const CONNECTION_ID = "cconn_config_connection_compat";
const CONNECTION_WALLET_RECORD_ID = "cwlt_config_connection_compat";
const CONNECTION_WALLET_ID = "privy_config_connection_wallet";
const CONFIG_PUBLIC_KEY = "11111111111111111111111111111111";
const CONNECTION_PUBLIC_KEY = "Vote111111111111111111111111111111111111111";
const API_KEY = {
  id: "key_custody_config_connection_compat",
  raw: "sk_test_custody_config_connection_compat",
  prefix: "sk_test_ccc",
};

const CACHED_API_KEY: CachedApiKey = {
  id: API_KEY.id,
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
};

describe("custody Config beside a BYOK Connection", () => {
  const original = {
    privyAppId: env.PRIVY_APP_ID,
    privyAppSecret: env.PRIVY_APP_SECRET,
    paraApiKey: env.PARA_API_KEY,
  };

  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedScope();
    custodyReleaseChannel.outOfChannelMode = null;
    env.PRIVY_APP_ID = undefined;
    env.PRIVY_APP_SECRET = undefined;
    env.PARA_API_KEY = "para_config_connection_compat";
  });

  afterEach(async () => {
    env.PRIVY_APP_ID = original.privyAppId;
    env.PRIVY_APP_SECRET = original.privyAppSecret;
    env.PARA_API_KEY = original.paraApiKey;
    await clearKVStores(env);
  });

  it("lists only the Managed Config and gates the Connection wallet on its own credential", async () => {
    const configs = await request("/v1/wallets/configs");
    expect(configs.status).toBe(200);
    expect(await configs.json()).toEqual(configsBody());

    const available = await request(`/v1/wallets/${CONNECTION_WALLET_ID}?includeBalance=false`);
    expect(available.status).toBe(200);
    expect(await available.json()).toEqual(connectionWalletBody(true));

    await getDb(env)
      .prepare("UPDATE provider_credentials SET status = 'failed_validation' WHERE id = ?")
      .bind(CREDENTIAL_ID)
      .run();

    const unavailable = await request(`/v1/wallets/${CONNECTION_WALLET_ID}?includeBalance=false`);
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toEqual(connectionWalletBody(false));
  });

  it("answers the named Connection wallet's public key and refuses a request that names none", async () => {
    const connectionPublicKey = await request(
      `/v1/wallets/public-key?walletId=${CONNECTION_WALLET_ID}`
    );
    expect(connectionPublicKey.status).toBe(200);
    expect(await connectionPublicKey.json()).toEqual({
      data: { publicKey: CONNECTION_PUBLIC_KEY },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });

    const unnamed = await request("/v1/wallets/public-key");
    expect(unnamed.status).toBe(400);
    expect(await unnamed.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "walletId is required" },
      meta: { requestId: expect.any(String) },
    });
  });

  it("refuses an out-of-channel Connection wallet without touching the Config listing", async () => {
    custodyReleaseChannel.outOfChannelMode = "byok";

    expect(await (await request("/v1/wallets/configs")).json()).toEqual(configsBody());
    const publicKey = await request(`/v1/wallets/public-key?walletId=${CONNECTION_WALLET_ID}`);
    expect(publicKey.status).toBe(403);
    expect(await publicKey.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: custodyProviderNotInReleaseChannel("privy", "byok").message,
        details: { reason: "custody_provider_not_in_release_channel" },
      },
      meta: { requestId: expect.any(String) },
    });
  });
});

function configsBody() {
  return {
    data: {
      configs: [
        {
          id: CONFIG_ID,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          provider: "para",
          status: "active",
          createdAt: expect.any(String),
        },
      ],
    },
    meta: { requestId: expect.any(String), timestamp: expect.any(String) },
  };
}

function connectionWalletBody(isRuntimeExecutionAllowed: boolean) {
  return {
    data: {
      wallet: {
        id: CONNECTION_WALLET_RECORD_ID,
        custodyConnectionId: CONNECTION_ID,
        provider: "privy",
        isRuntimeExecutionAllowed,
        walletId: CONNECTION_WALLET_ID,
        publicKey: CONNECTION_PUBLIC_KEY,
        label: "Connection wallet",
        purpose: "root",
        status: "active",
        createdAt: expect.any(String),
      },
    },
    meta: { requestId: expect.any(String), timestamp: expect.any(String) },
  };
}

async function request(path: string): Promise<Response> {
  return app.request(
    path,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY.raw}` },
    },
    env
  );
}

async function seedScope(): Promise<void> {
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, CACHED_API_KEY);
  const db = getDb(env);

  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        ORGANIZATION_ID,
        "Custody Config Connection Compat",
        "custody-config-connection-compat",
        "enterprise",
        "active"
      ),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "custody-config-connection-compat@example.com", 1, "active"),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
          role, permissions, status)
       VALUES (?, ?, ?, ?, 'Custody Config Connection Compat', ?, ?, 'api_admin', ?, 'active')`,
      [
        API_KEY.id,
        ORGANIZATION_ID,
        PROJECT_ID,
        USER_ID,
        API_KEY.prefix,
        keyHash,
        JSON.stringify(["*"]),
      ]
    );
    await insertTestCustodyConfigRow(tx, {
      id: CONFIG_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "para",
      configEncrypted: "test-config",
      status: "active",
    });
    await insertTestCustodyWalletRow(tx, {
      id: "cwlt_config_connection_compat_config",
      owner: { kind: "config", custodyConfigId: CONFIG_ID },
      walletId: CONFIG_WALLET_ID,
      publicKey: CONFIG_PUBLIC_KEY,
      label: "Config wallet",
      purpose: "root",
      status: "active",
    });
    await seedTestPrivyConnection(tx, {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      connectionId: CONNECTION_ID,
      credentialId: CREDENTIAL_ID,
      createdBy: USER_ID,
      stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "ciphertext" },
      providerAccountFingerprint: "sha256:compat",
      lastCheckStatus: "success",
      wallets: [
        {
          id: CONNECTION_WALLET_RECORD_ID,
          walletId: CONNECTION_WALLET_ID,
          publicKey: CONNECTION_PUBLIC_KEY,
          label: "Connection wallet",
          purpose: "root",
          status: "active",
        },
      ],
      defaultCustodyWalletId: CONNECTION_WALLET_RECORD_ID,
    });
  });
}
