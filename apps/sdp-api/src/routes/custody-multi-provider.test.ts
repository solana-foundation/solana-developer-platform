import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, CustodyMode } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { custodyProviderNotInReleaseChannel } from "@/services/provider-availability.service";
import { insertTestCustodyConfigRow, seedTestCustodyRows } from "@/test/helpers/custody";
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

const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

const PRIVY_CONFIG_ID = "cust_cfg_privy_multi";
const PARA_CONFIG_ID = "cust_cfg_para_multi";

let originalParaApiKey: string | undefined;
let originalPrivyAppId: string | undefined;
let originalPrivyAppSecret: string | undefined;
let originalCustodyEncryptionKey: string | undefined;

async function initializeProvider(body: { provider: "para" }): Promise<Response> {
  return app.request(
    "/v1/wallets/initialize",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
      },
      body: JSON.stringify(body),
    },
    env
  );
}

function channelRefusalBody(provider: "para" | "privy", mode: CustodyMode) {
  return {
    error: {
      code: "FORBIDDEN",
      message: custodyProviderNotInReleaseChannel(provider, mode).message,
      details: { reason: "custody_provider_not_in_release_channel" },
    },
    meta: { requestId: expect.any(String) },
  };
}

async function removeParaConfig() {
  const db = getDb(env);
  await db.batch([
    db.prepare("DELETE FROM custody_wallets WHERE custody_config_id = ?").bind(PARA_CONFIG_ID),
    db.prepare("DELETE FROM custody_configs WHERE id = ?").bind(PARA_CONFIG_ID),
  ]);
  const providerFetch = vi.fn(async () =>
    Response.json({
      id: "para_wallet_initialized",
      address: "11111111111111111111111111111111",
      type: "SOLANA",
      scheme: "ED25519",
      status: "ready",
    })
  );
  vi.stubGlobal("fetch", providerFetch);
  return providerFetch;
}

async function readAuditActions() {
  return getDb(env).queryMany<{ action: string }>(
    "SELECT action FROM audit_logs WHERE organization_id = ? ORDER BY ledger_sequence",
    [TEST_ORG.id]
  );
}

async function seedAuthAndConfigs(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

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
       (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      TEST_API_KEY.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_USER.id,
      "Custody Multi Provider Test Key",
      TEST_API_KEY.prefix,
      keyHash,
      "api_admin",
      JSON.stringify(["*"]),
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
        publicKey: "privy_pubkey_a",
        label: "Privy Root A",
        purpose: "root",
        status: "active",
      },
      {
        id: "cwlt_privy_b",
        owner: { kind: "config", custodyConfigId: PRIVY_CONFIG_ID },
        walletId: "privy_wallet_b",
        publicKey: "privy_pubkey_b",
        label: "Privy Root B",
        purpose: "transfer",
        status: "active",
      },
      {
        id: "cwlt_para_a",
        owner: { kind: "config", custodyConfigId: PARA_CONFIG_ID },
        walletId: "para_wallet_a",
        publicKey: "11111111111111111111111111111111",
        label: "Para Root A",
        purpose: "root",
        status: "active",
      },
      {
        id: "cwlt_para_b",
        owner: { kind: "config", custodyConfigId: PARA_CONFIG_ID },
        walletId: "para_wallet_b",
        publicKey: "para_pubkey_b",
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
  const publicKey = "11111111111111111111111111111111";
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
    originalParaApiKey = env.PARA_API_KEY;
    custodyReleaseChannel.outOfChannelMode = null;
    originalPrivyAppId = env.PRIVY_APP_ID;
    originalPrivyAppSecret = env.PRIVY_APP_SECRET;
    originalCustodyEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
    env.CUSTODY_ENCRYPTION_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
    env.PARA_API_KEY = "para_test_api_key";
    await seedTestDatabase(env);
    await seedAuthAndConfigs();
  });

  afterEach(async () => {
    env.PARA_API_KEY = originalParaApiKey;
    env.PRIVY_APP_ID = originalPrivyAppId;
    env.PRIVY_APP_SECRET = originalPrivyAppSecret;
    env.CUSTODY_ENCRYPTION_KEY = originalCustodyEncryptionKey;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await clearKVStores(env);
  });

  it("rejects Managed initialization out of channel before any Provider call or row", async () => {
    const providerFetch = await removeParaConfig();
    custodyReleaseChannel.outOfChannelMode = "managed";

    const response = await initializeProvider({ provider: "para" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(channelRefusalBody("para", "managed"));
    expect(providerFetch).not.toHaveBeenCalled();
    expect(
      await getDb(env).queryMany("SELECT id FROM custody_configs WHERE provider = 'para'")
    ).toEqual([]);
    expect(
      await getDb(env).queryMany(
        "SELECT id FROM custody_wallets WHERE wallet_id = 'para_wallet_initialized'"
      )
    ).toEqual([]);
    expect(await readAuditActions()).toEqual([]);
  });

  it("lists every provider's wallets", async () => {
    const response = await app.request(
      "/v1/wallets",
      { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        wallets: Array<{ id: string; provider: string; custodyConfigId: string; walletId: string }>;
      };
    };
    expect(
      body.data.wallets
        .map((wallet) => ({
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
      const body = (await response.json()) as {
        data: {
          wallets: Array<Record<string, unknown> & { walletId: string }>;
        };
      };
      return body.data.wallets.find((wallet) => wallet.walletId === connection.walletId);
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
    const body = (await res.json()) as {
      data: { configs: Array<{ id: string }> };
    };

    expect(Object.keys(body.data)).toEqual(["configs"]);
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

  it("returns 404 when creating a wallet for an uninitialized provider", async () => {
    const res = await app.request(
      "/v1/wallets",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "coinbase_cdp",
          label: "Missing provider wallet",
        }),
      },
      env
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
      };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("Custody not initialized");
  });

  it("returns 404 when deleting a wallet for an uninitialized provider", async () => {
    const res = await app.request(
      "/v1/wallets",
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "coinbase_cdp",
          walletId: "cdp_wallet_missing",
        }),
      },
      env
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
      };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("Custody not initialized");
  });
});
