import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { custodyConfigsResponse, custodyWalletsResponse } from "@/openapi/paths/responses";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { insertTestCustodyConfigRow, seedTestCustodyRows } from "@/test/helpers/custody";
import { seedTestPrivyConnection } from "@/test/helpers/custody-connections";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { type SeededApiKey, seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

const TEST_ORG = {
  id: "org_custody_multi_provider",
  name: "Custody Multi Provider Org",
  slug: "custody-multi-provider-org",
};

const TEST_PROJECT = {
  id: "prj_test_custody_multi_provider",
  slug: "test-custody-multi-provider-project",
};

const TEST_USER = {
  id: "usr_custody_multi_provider",
  email: "custody-multi-provider@example.com",
};

const TEST_API_KEY = {
  id: "key_custody_multi_provider",
  raw: "sk_test_custody_multi_provider",
  prefix: "sk_test_cus",
};

const TEST_SEEDED_API_KEY: SeededApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  grants: ALL_API_KEY_GRANTS,
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  status: "active",
  expiresAt: null,
};

const PRIVY_CONFIG_ID = "cust_cfg_privy_multi";
const PARA_CONFIG_ID = "cust_cfg_para_multi";

async function seedAuthAndConfigs(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, keyHash, TEST_SEEDED_API_KEY);

  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
  });
  await getDb(env).execute(
    `INSERT INTO api_keys
       (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      TEST_API_KEY.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_USER.id,
      "Custody Multi Provider Test Key",
      TEST_API_KEY.prefix,
      keyHash,
      ALL_API_KEY_GRANTS,
      "active",
    ]
  );
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: PRIVY_CONFIG_ID,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        provider: "privy",
        configEncrypted: "test-config",
        status: "active",
      },
      {
        id: PARA_CONFIG_ID,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        provider: "para",
        configEncrypted: "test-config",
        status: "active",
      },
    ],
    wallets: [
      {
        id: "cwlt_privy_a",
        owner: { kind: "config", custodyConfigId: PRIVY_CONFIG_ID },
        walletId: "privy_wallet_a",
        publicKey: syntheticAddress(1),
        label: "Privy Root A",
        purpose: "root",
        status: "active",
      },
      {
        id: "cwlt_privy_b",
        owner: { kind: "config", custodyConfigId: PRIVY_CONFIG_ID },
        walletId: "privy_wallet_b",
        publicKey: syntheticAddress(2),
        label: "Privy Root B",
        purpose: "transfer",
        status: "active",
      },
      {
        id: "cwlt_para_a",
        owner: { kind: "config", custodyConfigId: PARA_CONFIG_ID },
        walletId: "para_wallet_a",
        publicKey: syntheticAddress(3),
        label: "Para Root A",
        purpose: "root",
        status: "active",
      },
      {
        id: "cwlt_para_b",
        owner: { kind: "config", custodyConfigId: PARA_CONFIG_ID },
        walletId: "para_wallet_b",
        publicKey: syntheticAddress(4),
        label: "Para Root B",
        purpose: "transfer",
        status: "active",
      },
    ],
  });
}

async function seedActivePrivyConnection(suffix: string) {
  const connectionId = `cconn_multi_${suffix}`;
  const walletRecordId = `cwlt_multi_${suffix}`;
  const walletId = `privy_multi_${suffix}`;
  const publicKey = syntheticAddress(5);
  const credentialId = `pcred_multi_${suffix}`;

  await getDb(env).transaction((tx) =>
    seedTestPrivyConnection(tx, {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      connectionId,
      credentialId,
      createdBy: TEST_USER.id,
      stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "ciphertext" },
      providerAccountFingerprint: `sha256:${credentialId}`,
      lastCheckStatus: "success",
      wallets: [
        { id: walletRecordId, walletId, publicKey, label: null, purpose: null, status: "active" },
      ],
      defaultCustodyWalletId: walletRecordId,
    })
  );

  return { connectionId, walletId, publicKey };
}

describe("Custody multi-provider routes", () => {
  beforeEach(async () => {
    custodyReleaseChannel.outOfChannelMode = null;
    await seedTestDatabase(env);
    await seedAuthAndConfigs();
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("lists every provider's wallets", async () => {
    const response = await app.request(
      "/v1/wallets",
      { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(response.status).toBe(200);
    expect(
      custodyWalletsResponse
        .parse(await response.json())
        .data.wallets.map((wallet) => ({
          id: wallet.id,
          provider: wallet.provider,
          custodyConfigId: wallet.custodyConfigId,
          walletId: wallet.walletId,
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    ).toEqual([
      {
        id: "cwlt_para_a",
        provider: "para",
        custodyConfigId: PARA_CONFIG_ID,
        walletId: "para_wallet_a",
      },
      {
        id: "cwlt_para_b",
        provider: "para",
        custodyConfigId: PARA_CONFIG_ID,
        walletId: "para_wallet_b",
      },
      {
        id: "cwlt_privy_a",
        provider: "privy",
        custodyConfigId: PRIVY_CONFIG_ID,
        walletId: "privy_wallet_a",
      },
      {
        id: "cwlt_privy_b",
        provider: "privy",
        custodyConfigId: PRIVY_CONFIG_ID,
        walletId: "privy_wallet_b",
      },
    ]);
  });

  it("keeps active Connection wallets visible with fresh Runtime Execution Admission", async () => {
    const connection = await seedActivePrivyConnection("inventory");

    const readWallet = async () => {
      const response = await app.request(
        "/v1/wallets",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(response.status).toBe(200);
      return custodyWalletsResponse
        .parse(await response.json())
        .data.wallets.find((wallet) => wallet.walletId === connection.walletId);
    };

    await expect(readWallet()).resolves.toMatchObject({
      custodyConnectionId: connection.connectionId,
      isRuntimeExecutionAllowed: true,
      provider: "privy",
    });

    custodyReleaseChannel.outOfChannelMode = "byok";
    await expect(readWallet()).resolves.toMatchObject({
      custodyConnectionId: connection.connectionId,
      isRuntimeExecutionAllowed: false,
      provider: "privy",
    });

    custodyReleaseChannel.outOfChannelMode = null;
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ providerOverrides: { custody: { privy: false } } }), TEST_ORG.id)
      .run();
    await expect(readWallet()).resolves.toMatchObject({
      custodyConnectionId: connection.connectionId,
      isRuntimeExecutionAllowed: false,
      provider: "privy",
    });
  });

  it("returns every active config, with or without wallets, from /v1/wallets/configs", async () => {
    const walletlessConfigId = "cust_cfg_walletless";
    await getDb(env).transaction((tx) =>
      insertTestCustodyConfigRow(tx, {
        id: walletlessConfigId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        provider: "turnkey",
        configEncrypted: "test-config",
        status: "active",
      })
    );

    const res = await app.request(
      "/v1/wallets/configs",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Object.keys(json.data)).toEqual(["configs"]);
    const body = custodyConfigsResponse.parse(json);

    expect([...body.data.configs].sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      {
        id: PARA_CONFIG_ID,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        provider: "para",
        status: "active",
        createdAt: expect.any(String),
      },
      {
        id: PRIVY_CONFIG_ID,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        provider: "privy",
        status: "active",
        createdAt: expect.any(String),
      },
      {
        id: walletlessConfigId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        provider: "turnkey",
        status: "active",
        createdAt: expect.any(String),
      },
    ]);
  });
});
