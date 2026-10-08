import { hashString } from "@sdp/payments/hash";
import * as solanaRpc from "@sdp/rpc/solana";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import * as heliusDasService from "@/services/helius-das.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { insertTestCustodyWalletRow, seedTestCustodyRows } from "@/test/helpers/custody";
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

const createRpcMock = vi.spyOn(solanaRpc, "createRpc");
const getAccountInfoMock = vi.spyOn(solanaRpc, "getAccountInfo");
const attachUsdValuesMock = vi.spyOn(heliusDasService, "attachUsdValuesToBalances");

const TEST_ORG = {
  id: "org_custody_wallet_by_id",
  name: "Custody Wallet By ID Org",
  slug: "custody-wallet-by-id-org",
};

const TEST_PROJECT = {
  id: "prj_test_custody_wallet_by_id",
  slug: "test-custody-wallet-by-id-project",
};

const TEST_USER = {
  id: "usr_custody_wallet_by_id",
  email: "custody-wallet-by-id@example.com",
};

const TEST_API_KEY = {
  id: "key_custody_wallet_by_id",
  raw: "sk_test_custody_wallet_by_id",
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

const PRIVY_CONFIG_ID = "cust_cfg_wallet_by_id_privy";
const PARA_CONFIG_ID = "cust_cfg_wallet_by_id_para";

async function seedAuthAndConfigs(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "individual", "active"),
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
      "Custody Wallet By ID Test Key",
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
        projectId: null,
        provider: "privy",
        configEncrypted: "test-config",
        defaultWalletId: "privy_wallet_a",
        status: "active",
      },
      {
        id: PARA_CONFIG_ID,
        organizationId: TEST_ORG.id,
        projectId: null,
        provider: "para",
        configEncrypted: "test-config",
        defaultWalletId: "para_wallet_a",
        status: "active",
      },
    ],
    wallets: [
      {
        id: "cwlt_wallet_by_id_privy_a",
        owner: { kind: "config", custodyConfigId: PRIVY_CONFIG_ID },
        walletId: "privy_wallet_a",
        publicKey: TEST_SOLANA_ADDRESSES.wallet1,
        label: "Privy Wallet A",
        purpose: "root",
        status: "active",
      },
      {
        id: "cwlt_wallet_by_id_para_a",
        owner: { kind: "config", custodyConfigId: PARA_CONFIG_ID },
        walletId: "para_wallet_a",
        publicKey: TEST_SOLANA_ADDRESSES.wallet2,
        label: "Para Wallet A",
        purpose: "transfer",
        status: "active",
      },
    ],
    scopeDefaults: [
      {
        id: "csd_wallet_by_id_org_default",
        organizationId: TEST_ORG.id,
        projectId: null,
        defaultCustodyConfigId: PRIVY_CONFIG_ID,
        defaultCustodyConnectionId: null,
      },
    ],
  });
}

async function seedCachedKey(override: Partial<CachedApiKey>): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, {
    ...TEST_CACHED_API_KEY,
    ...override,
  });
}

describe("Custody wallet by ID route", () => {
  beforeEach(async () => {
    custodyReleaseChannel.outOfChannelMode = null;
    vi.clearAllMocks();
    createRpcMock.mockReset();
    getAccountInfoMock.mockReset();
    attachUsdValuesMock.mockReset();

    createRpcMock.mockReturnValue({} as ReturnType<typeof solanaRpc.createRpc>);
    getAccountInfoMock.mockResolvedValue({
      lamports: 4200000000n,
    } as Awaited<ReturnType<typeof solanaRpc.getAccountInfo>>);
    attachUsdValuesMock.mockImplementation(async (_env, balances) => balances);
    await seedTestDatabase(env);
    await seedAuthAndConfigs();
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("reads and labels a Connection wallet without exposing a Config owner", async () => {
    const connection = await seedConnectionWallet();

    for (const selector of [connection.walletId, connection.walletRecordId]) {
      const response = await app.request(
        `/v1/wallets/${selector}?includeBalance=false`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: {
          wallet: {
            id: connection.walletRecordId,
            custodyConnectionId: connection.connectionId,
            isRuntimeExecutionAllowed: true,
            provider: "privy",
            walletId: connection.walletId,
          },
        },
      });
    }

    custodyReleaseChannel.outOfChannelMode = "byok";
    const update = await app.request(
      `/v1/wallets/${connection.walletRecordId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ label: "Connection treasury" }),
      },
      env
    );
    expect(update.status).toBe(200);
    expect(await update.json()).toEqual({
      data: {
        wallet: {
          id: connection.walletRecordId,
          custodyConnectionId: connection.connectionId,
          provider: "privy",
          isDefaultProvider: false,
          isRuntimeExecutionAllowed: false,
          walletId: connection.walletId,
          publicKey: connection.publicKey,
          label: "Connection treasury",
          purpose: null,
          status: "active",
          createdAt: expect.any(String),
        },
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });

  it("returns a persisted Connection public key while the BYOK pair is out of channel", async () => {
    const connection = await seedConnectionWallet();
    custodyReleaseChannel.outOfChannelMode = "byok";

    const response = await app.request(
      `/v1/wallets/public-key?walletId=${connection.walletId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
      },
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { publicKey: connection.publicKey },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });

    const alias = await app.request(
      `/v1/wallets/public-key?walletId=${connection.walletRecordId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
      },
      env
    );
    expect(alias.status).toBe(404);
  });

  it("returns 404 for a wallet under a non-active Connection", async () => {
    const connection = await seedConnectionWallet();
    await getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET status = 'deactivated', deactivated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(connection.connectionId)
      .run();

    const list = await app.request(
      "/v1/wallets",
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(list.status).toBe(200);
    expect(await list.json()).not.toMatchObject({
      data: { wallets: expect.arrayContaining([{ walletId: connection.walletId }]) },
    });

    for (const path of [
      `/v1/wallets/${connection.walletId}?includeBalance=false`,
      `/v1/wallets/public-key?walletId=${connection.walletId}`,
    ]) {
      const response = await app.request(
        path,
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );
      expect(response.status).toBe(404);
    }
  });

  it("returns 409 when the record-ID alias collides with a canonical wallet ID", async () => {
    const connection = await seedConnectionWallet();
    await insertTestCustodyWalletRow(getDb(env), {
      id: connection.walletId,
      owner: { kind: "connection", custodyConnectionId: connection.connectionId },
      walletId: "privy_alias_collision_other",
      publicKey: TEST_SOLANA_ADDRESSES.wallet1,
      label: null,
      purpose: null,
      status: "active",
    });

    const detail = await app.request(
      `/v1/wallets/${connection.walletId}?includeBalance=false`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(detail.status).toBe(409);

    const update = await app.request(
      `/v1/wallets/${connection.walletId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ label: "Ambiguous" }),
      },
      env
    );
    expect(update.status).toBe(409);

    const canonicalOnly = await app.request(
      `/v1/wallets/public-key?walletId=${connection.walletId}`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(canonicalOnly.status).toBe(200);
  });

  it("returns wallet metadata and SOL balance for a wallet across active providers", async () => {
    const res = await app.request(
      "/v1/wallets/para_wallet_a",
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
      data: {
        wallet: {
          id: string;
          custodyConfigId: string;
          provider: string;
          walletId: string;
          publicKey: string;
          balance: {
            token: string;
            amount: string;
            decimals: number;
          };
        };
      };
    };

    expect(body.data.wallet.id).toBe("cwlt_wallet_by_id_para_a");
    expect(body.data.wallet.custodyConfigId).toBe(PARA_CONFIG_ID);
    expect(body.data.wallet.provider).toBe("para");
    expect(body.data.wallet.walletId).toBe("para_wallet_a");
    expect(body.data.wallet.publicKey).toBe(TEST_SOLANA_ADDRESSES.wallet2);
    expect(body.data.wallet.balance).toMatchObject({
      token: "SOL",
      amount: "4200000000",
      decimals: 9,
    });
    expect(createRpcMock).toHaveBeenCalledTimes(1);
    expect(getAccountInfoMock).toHaveBeenCalledTimes(1);
    expect(attachUsdValuesMock).toHaveBeenCalledTimes(1);
  });

  it("returns metadata without entering RPC or pricing when includeBalance=false", async () => {
    let signalRpcStarted!: () => void;
    const rpcStarted = new Promise<void>((resolve) => {
      signalRpcStarted = resolve;
    });

    let releaseRpc!: (accountInfo: Awaited<ReturnType<typeof solanaRpc.getAccountInfo>>) => void;
    const rpcGate = new Promise<Awaited<ReturnType<typeof solanaRpc.getAccountInfo>>>((resolve) => {
      releaseRpc = resolve;
    });

    getAccountInfoMock.mockImplementationOnce(async () => {
      signalRpcStarted();
      return rpcGate;
    });

    const request = Promise.resolve(
      app.request(
        "/v1/wallets/para_wallet_a?includeBalance=false",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      )
    );

    const firstCompleted = await Promise.race([
      request.then((response) => ({ kind: "response" as const, response })),
      rpcStarted.then(() => ({ kind: "rpc" as const })),
    ]);

    if (firstCompleted.kind === "rpc") {
      releaseRpc({
        lamports: 4200000000n,
      } as Awaited<ReturnType<typeof solanaRpc.getAccountInfo>>);
      await request;
    }

    expect(firstCompleted.kind).toBe("response");
    if (firstCompleted.kind !== "response") {
      return;
    }

    expect(firstCompleted.response.status).toBe(200);
    const body = (await firstCompleted.response.json()) as {
      data: {
        wallet: Record<string, unknown>;
      };
    };

    expect(body.data.wallet).toMatchObject({
      id: "cwlt_wallet_by_id_para_a",
      provider: "para",
      walletId: "para_wallet_a",
      publicKey: TEST_SOLANA_ADDRESSES.wallet2,
    });
    expect(body.data.wallet).not.toHaveProperty("balance");
    expect(createRpcMock).not.toHaveBeenCalled();
    expect(getAccountInfoMock).not.toHaveBeenCalled();
    expect(attachUsdValuesMock).not.toHaveBeenCalled();
  });

  it("includes the balance when includeBalance=true is explicit", async () => {
    const res = await app.request(
      "/v1/wallets/para_wallet_a?includeBalance=true",
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
      data: {
        wallet: {
          balance?: { amount: string };
        };
      };
    };
    expect(body.data.wallet.balance).toMatchObject({ amount: "4200000000" });
    expect(createRpcMock).toHaveBeenCalledTimes(1);
    expect(getAccountInfoMock).toHaveBeenCalledTimes(1);
    expect(attachUsdValuesMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the balance-on default when includeBalance is empty", async () => {
    const res = await app.request(
      "/v1/wallets/para_wallet_a?includeBalance=",
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
      data: {
        wallet: {
          balance?: { amount: string };
        };
      };
    };
    expect(body.data.wallet.balance).toMatchObject({ amount: "4200000000" });
    expect(createRpcMock).toHaveBeenCalledTimes(1);
    expect(getAccountInfoMock).toHaveBeenCalledTimes(1);
    expect(attachUsdValuesMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await app.request(
      "/v1/wallets/para_wallet_a",
      {
        method: "GET",
      },
      env
    );

    expect(res.status).toBe(401);
  });

  it("returns 404 when the wallet does not exist", async () => {
    const res = await app.request(
      "/v1/wallets/does_not_exist",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(404);
  });

  it("returns 404 for API keys bound to a different wallet to avoid wallet enumeration", async () => {
    await seedCachedKey({
      walletBindings: [
        {
          walletId: "privy_wallet_a",
          permissions: ["wallets:read"],
        },
      ],
    });

    const res = await app.request(
      "/v1/wallets/para_wallet_a",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(404);
  });

  it("returns 403 when the API key does not include wallets:read permission", async () => {
    await seedCachedKey({
      permissions: ["payments:read"],
    });

    const res = await app.request(
      "/v1/wallets/para_wallet_a",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(403);
  });

  it("falls back to a zero SOL balance when the RPC lookup fails", async () => {
    getAccountInfoMock.mockRejectedValueOnce(new Error("RPC unavailable"));

    const res = await app.request(
      "/v1/wallets/para_wallet_a",
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
      data: {
        wallet: {
          balance: {
            token: string;
            amount: string;
            uiAmount: string;
            decimals: number;
          };
        };
      };
    };

    expect(body.data.wallet.balance).toMatchObject({
      token: "SOL",
      amount: "0",
      uiAmount: "0",
      decimals: 9,
    });
  });
});

async function seedConnectionWallet() {
  const credentialId = "pcred_wallet_by_id_connection";
  const connectionId = "cconn_wallet_by_id_connection";
  const walletRecordId = "cwlt_wallet_by_id_connection";
  const walletId = "privy_wallet_by_id_connection";
  const publicKey = TEST_SOLANA_ADDRESSES.wallet3;

  await getDb(env).transaction((tx) =>
    seedTestPrivyConnection(tx, {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      connectionId,
      credentialId,
      createdBy: TEST_USER.id,
      stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "ciphertext" },
      providerAccountFingerprint: "sha256:wallet-by-id",
      lastCheckStatus: "success",
      wallets: [
        {
          id: walletRecordId,
          walletId,
          publicKey,
          label: "Connection wallet",
          purpose: null,
          status: "active",
        },
      ],
      defaultCustodyWalletId: walletRecordId,
    })
  );

  return { connectionId, walletId, walletRecordId, publicKey };
}
