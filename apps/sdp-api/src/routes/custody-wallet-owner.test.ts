import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import {
  seedTestPrivyConnection,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const provisionPrivyWalletMock = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");

const ORGANIZATION_ID = "org_custody_wallet_owner";
const PROJECT_ID = "prj_custody_wallet_owner";
const USER_ID = "usr_custody_wallet_owner";
const CONFIG_ID = "cust_cfg_wallet_owner_privy";
const CONFIG_WALLET_RECORD_ID = "cwlt_wallet_owner_config";
const CREDENTIAL_ID = "pcred_wallet_owner";
const CONNECTION_ID = "cconn_wallet_owner";
const CONNECTION_WALLET_RECORD_ID = "cwlt_wallet_owner_connection";
const CONNECTION_WALLET_ID = "privy_wallet_owner_connection";
const CONNECTION_WALLET_PUBLIC_KEY = "So11111111111111111111111111111111111111112";
const CREATED_PUBLIC_KEY = "Vote111111111111111111111111111111111111111";
const API_KEY = {
  id: "key_custody_wallet_owner",
  raw: "sk_test_custody_wallet_owner",
  prefix: "sk_test_cwo",
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

const originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
const originalPrivyAppId = env.PRIVY_APP_ID;
const originalPrivyAppSecret = env.PRIVY_APP_SECRET;

async function seedFixture(): Promise<void> {
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, CACHED_API_KEY);
  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')"
      )
      .bind(ORGANIZATION_ID, "Wallet owner", "wallet-owner"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER_ID, "wallet-owner@example.com"),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await getDb(env).execute(
    `INSERT INTO api_keys (
       id, organization_id, project_id, created_by, name, key_prefix,
       key_hash, role, permissions, status
     ) VALUES (?, ?, ?, ?, 'Test', ?, ?, 'api_admin', '["*"]', 'active')`,
    [API_KEY.id, ORGANIZATION_ID, PROJECT_ID, USER_ID, API_KEY.prefix, keyHash]
  );
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
        configEncrypted: JSON.stringify({ provider: "privy" }),
        status: "active",
      },
    ],
    wallets: [
      {
        id: CONFIG_WALLET_RECORD_ID,
        owner: { kind: "config", custodyConfigId: CONFIG_ID },
        walletId: "privy_wallet_owner_config",
        publicKey: "11111111111111111111111111111111",
        label: "Managed",
        purpose: "root",
        status: "active",
      },
    ],
  });
  const stored = await writeTestPrivyCredentialSecret(env, {
    organizationId: ORGANIZATION_ID,
    credentialId: CREDENTIAL_ID,
    appId: "wallet-owner-app",
    appSecret: "wallet-owner-secret",
  });
  await getDb(env).transaction((tx) =>
    seedTestPrivyConnection(tx, {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      connectionId: CONNECTION_ID,
      credentialId: CREDENTIAL_ID,
      createdBy: USER_ID,
      stored,
      providerAccountFingerprint: `sha256:${CREDENTIAL_ID}`,
      lastCheckStatus: "success",
      wallets: [
        {
          id: CONNECTION_WALLET_RECORD_ID,
          walletId: CONNECTION_WALLET_ID,
          publicKey: CONNECTION_WALLET_PUBLIC_KEY,
          label: "Connection",
          purpose: null,
          status: "active",
        },
      ],
      defaultCustodyWalletId: CONNECTION_WALLET_RECORD_ID,
    })
  );
}

async function createWallet(body: Record<string, unknown>): Promise<Response> {
  return app.request(
    "/v1/wallets",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY.raw}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env
  );
}

async function readPublicKey(query: string): Promise<Response> {
  return app.request(
    `/v1/wallets/public-key${query}`,
    { method: "GET", headers: { Authorization: `Bearer ${API_KEY.raw}` } },
    env
  );
}

async function readWalletRows() {
  return getDb(env).queryMany<{
    id: string;
    custody_config_id: string | null;
    custody_connection_id: string | null;
    wallet_id: string;
  }>(
    "SELECT id, custody_config_id, custody_connection_id, wallet_id FROM custody_wallets ORDER BY id"
  );
}

describe("Custody wallet owner contract", () => {
  beforeEach(async () => {
    provisionPrivyWalletMock.mockReset();
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
    env.PRIVY_APP_ID = "managed-wallet-owner-app";
    env.PRIVY_APP_SECRET = "managed-wallet-owner-secret";
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
    env.PRIVY_APP_ID = originalPrivyAppId;
    env.PRIVY_APP_SECRET = originalPrivyAppSecret;
    await clearKVStores(env);
  });

  it.each([
    ["neither provider nor connectionId", { label: "Ownerless" }],
    ["both provider and connectionId", { provider: "privy", connectionId: CONNECTION_ID }],
  ])("rejects a wallet body naming %s before any provider call", async (_case, body) => {
    const before = await readWalletRows();

    const response = await createWallet(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
    expect(await readWalletRows()).toEqual(before);
  });

  it("creates a Managed wallet under the named provider's config", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "managed_created",
      address: CREATED_PUBLIC_KEY,
    });

    const response = await createWallet({
      provider: "privy",
      label: "Treasury",
      purpose: "transfer",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { wallet: { id: string } } };
    expect(body.data).toEqual({
      wallet: {
        id: expect.any(String),
        custodyConfigId: CONFIG_ID,
        isRuntimeExecutionAllowed: true,
        walletId: "privy_managed_created",
        publicKey: CREATED_PUBLIC_KEY,
        label: "Treasury",
        purpose: "transfer",
        status: "active",
        createdAt: expect.any(String),
      },
    });
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    expect(
      await getDb(env).queryOne(
        "SELECT custody_config_id, custody_connection_id, wallet_id, public_key FROM custody_wallets WHERE id = ?",
        [body.data.wallet.id]
      )
    ).toEqual({
      custody_config_id: CONFIG_ID,
      custody_connection_id: null,
      wallet_id: "privy_managed_created",
      public_key: CREATED_PUBLIC_KEY,
    });
  });

  it("creates a BYOK wallet under the named connection", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "connection_created",
      address: CREATED_PUBLIC_KEY,
    });

    const response = await createWallet({
      connectionId: CONNECTION_ID,
      label: "Settlement",
      purpose: "transfer",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { wallet: { id: string } } };
    expect(body.data).toEqual({
      wallet: {
        id: expect.any(String),
        custodyConnectionId: CONNECTION_ID,
        isRuntimeExecutionAllowed: true,
        walletId: "privy_connection_created",
        publicKey: CREATED_PUBLIC_KEY,
        label: "Settlement",
        purpose: "transfer",
        status: "active",
        createdAt: expect.any(String),
      },
    });
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    expect(
      await getDb(env).queryOne(
        "SELECT custody_config_id, custody_connection_id, wallet_id, public_key FROM custody_wallets WHERE id = ?",
        [body.data.wallet.id]
      )
    ).toEqual({
      custody_config_id: null,
      custody_connection_id: CONNECTION_ID,
      wallet_id: "privy_connection_created",
      public_key: CREATED_PUBLIC_KEY,
    });
  });

  it("requires walletId to read a public key", async () => {
    const response = await readPublicKey("");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "walletId is required" },
      meta: { requestId: expect.any(String) },
    });
  });

  it("reads the public key of the named wallet", async () => {
    const response = await readPublicKey(`?walletId=${CONNECTION_WALLET_ID}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { publicKey: CONNECTION_WALLET_PUBLIC_KEY },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });
});
