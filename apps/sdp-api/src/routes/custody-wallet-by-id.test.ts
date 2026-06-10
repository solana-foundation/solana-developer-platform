import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { hashString } from "@/lib/hash";
import * as solanaRpc from "@/services/solana/rpc";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";

const createRpcMock = vi.spyOn(solanaRpc, "createRpc");
const getAccountInfoMock = vi.spyOn(solanaRpc, "getAccountInfo");

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
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_ORG.id,
        "Test Project",
        TEST_PROJECT.slug,
        "sandbox",
        "active",
        TEST_USER.id
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "Custody Wallet By ID Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        PRIVY_CONFIG_ID,
        TEST_ORG.id,
        null,
        "privy",
        "test-config",
        "sdp-custody-encryption-v1",
        "privy_wallet_a",
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        PARA_CONFIG_ID,
        TEST_ORG.id,
        null,
        "para",
        "test-config",
        "sdp-custody-encryption-v1",
        "para_wallet_a",
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults
           (id, organization_id, project_id, default_custody_config_id)
         VALUES (?, ?, ?, ?)`
      )
      .bind("csd_wallet_by_id_org_default", TEST_ORG.id, null, PRIVY_CONFIG_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cwlt_wallet_by_id_privy_a",
        PRIVY_CONFIG_ID,
        "privy_wallet_a",
        TEST_SOLANA_ADDRESSES.wallet1,
        "Privy Wallet A",
        "root",
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cwlt_wallet_by_id_para_a",
        PARA_CONFIG_ID,
        "para_wallet_a",
        TEST_SOLANA_ADDRESSES.wallet2,
        "Para Wallet A",
        "transfer",
        "active"
      ),
  ]);
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
    vi.clearAllMocks();

    createRpcMock.mockReturnValue({} as ReturnType<typeof solanaRpc.createRpc>);
    getAccountInfoMock.mockResolvedValue({
      lamports: 4200000000n,
    } as Awaited<ReturnType<typeof solanaRpc.getAccountInfo>>);
    await seedTestDatabase(env);
    await seedAuthAndConfigs();
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
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

  it("returns 404 when the wallet belongs to a config in a different project in the same org", async () => {
    const otherProjectId = "prj_custody_wallet_cross_project";
    const otherConfigId = "cust_cfg_wallet_by_id_other_project";
    const otherWalletId = "privy_wallet_other_project";

    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          otherProjectId,
          TEST_ORG.id,
          "Other Project",
          "other-custody-wallet-project",
          "sandbox",
          "active",
          TEST_USER.id
        ),
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          otherConfigId,
          TEST_ORG.id,
          otherProjectId,
          "privy",
          "test-config",
          "sdp-custody-encryption-v1",
          otherWalletId,
          "active"
        ),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, label, purpose, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          "cwlt_wallet_by_id_other_project",
          otherConfigId,
          otherWalletId,
          TEST_SOLANA_ADDRESSES.wallet3,
          "Other Project Wallet",
          "root",
          "active"
        ),
    ]);

    const res = await app.request(
      `/v1/wallets/${otherWalletId}`,
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
