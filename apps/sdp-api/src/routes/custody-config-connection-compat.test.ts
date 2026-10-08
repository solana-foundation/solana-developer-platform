import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import {
  insertTestCustodyConfigRow,
  insertTestCustodyScopeDefault,
  insertTestCustodyWalletRow,
} from "@/test/helpers/custody";
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

describe("custody Config compatibility with an effective Connection", () => {
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

  it("projects the effective Connection without changing Config response shapes", async () => {
    const config = await request("/v1/wallets/config");
    expect(config.status).toBe(404);

    const configs = await request("/v1/wallets/configs");
    expect(configs.status).toBe(200);
    expect(await configs.json()).toEqual(nonDefaultConfigsBody());

    const options = await request("/v1/wallets/switch-options");
    expect(options.status).toBe(200);
    expect(await readProviderOption(options, "privy")).toMatchObject({
      provider: "privy",
      hasReusableWallet: true,
      needsWalletLabel: false,
      isActive: true,
      isDefault: true,
    });

    await getDb(env)
      .prepare("UPDATE provider_credentials SET status = 'failed_validation' WHERE id = ?")
      .bind(CREDENTIAL_ID)
      .run();

    const unavailableOptions = await request("/v1/wallets/switch-options");
    expect(await readProviderOption(unavailableOptions, "privy")).toMatchObject({
      provider: "privy",
      hasReusableWallet: true,
      needsWalletLabel: false,
      isActive: false,
      isDefault: true,
    });
  });

  it("keeps implicit public-key resolution aligned with the effective target", async () => {
    const connectionPublicKey = await request("/v1/wallets/public-key");
    expect(connectionPublicKey.status).toBe(200);
    expect(await connectionPublicKey.json()).toEqual({
      data: { publicKey: CONNECTION_PUBLIC_KEY },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });

  it("keeps a selected out-of-channel Connection effective instead of falling back to the Config", async () => {
    custodyReleaseChannel.outOfChannelMode = "byok";

    expect((await request("/v1/wallets/config")).status).toBe(404);
    expect(await (await request("/v1/wallets/configs")).json()).toEqual(nonDefaultConfigsBody());
    const publicKey = await request("/v1/wallets/public-key");
    expect(publicKey.status).toBe(200);
    expect(await publicKey.json()).toEqual({
      data: { publicKey: CONNECTION_PUBLIC_KEY },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });
});

function nonDefaultConfigsBody() {
  return {
    data: {
      configs: [
        {
          id: CONFIG_ID,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          provider: "para",
          publicKey: CONFIG_PUBLIC_KEY,
          defaultWalletId: CONFIG_WALLET_ID,
          status: "active",
          createdAt: expect.any(String),
          isDefault: false,
        },
      ],
      defaultConfigId: null,
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

async function readProviderOption(response: Response, provider: string) {
  const body = (await response.json()) as {
    data: { providers: Array<Record<string, unknown> & { provider: string }> };
  };
  return body.data.providers.find((option) => option.provider === provider);
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
      defaultWalletId: CONFIG_WALLET_ID,
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
    await insertTestCustodyScopeDefault(tx, {
      id: "csd_config_connection_compat",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      defaultCustodyConfigId: CONFIG_ID,
      defaultCustodyConnectionId: CONNECTION_ID,
    });
  });
}
