import type { CachedApiKey } from "@sdp/types";
import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { hashString } from "@/lib/hash";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import * as signingServiceModule from "@/services/domain/signing.service";
import * as solanaRpc from "@/services/solana/rpc";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";

const actualCreateSigningService = signingServiceModule.createSigningService;
const createRpcMock = vi.spyOn(solanaRpc, "createRpc");
const getAccountInfoMock = vi.spyOn(solanaRpc, "getAccountInfo");
const getSplTokenBalancesMock = vi.spyOn(tokenAccounts, "getSplTokenBalances");
const createSigningServiceMock = vi.spyOn(signingServiceModule, "createSigningService");

const TEST_ORG = {
  id: "org_custody_wallet_scope",
  name: "Custody Wallet Scope Org",
  slug: "custody-wallet-scope-org",
};

const TEST_PROJECT = {
  id: "prj_test_custody_wallet_scope",
  slug: "test-custody-wallet-scope-project",
};

const TEST_USER = {
  id: "usr_custody_wallet_scope",
  email: "custody-wallet-scope@example.com",
};

const TEST_API_KEY = {
  id: "key_custody_wallet_scope",
  raw: "sk_test_custody_wallet_scope",
  prefix: "sk_test_cws",
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

const PRIVY_CONFIG_ID = "cust_cfg_scope_privy";
const PARA_CONFIG_ID = "cust_cfg_scope_para";

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
        "Custody scope key",
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
      .bind("csd_scope_org_default", TEST_ORG.id, null, PRIVY_CONFIG_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cwlt_scope_privy_a",
        PRIVY_CONFIG_ID,
        "privy_wallet_a",
        "privy_pubkey_a",
        "A",
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
        "cwlt_scope_privy_b",
        PRIVY_CONFIG_ID,
        "privy_wallet_b",
        "privy_pubkey_b",
        "B",
        "transfer",
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cwlt_scope_para_a",
        PARA_CONFIG_ID,
        "para_wallet_a",
        "para_pubkey_a",
        "C",
        "root",
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

describe("Custody wallet scope routes", () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    createRpcMock.mockReturnValue({} as ReturnType<typeof solanaRpc.createRpc>);
    getAccountInfoMock.mockResolvedValue({
      lamports: 0n,
      owner: "11111111111111111111111111111111",
    } as Awaited<ReturnType<typeof solanaRpc.getAccountInfo>>);
    getSplTokenBalancesMock.mockResolvedValue([
      {
        token: "USDC",
        mint: "usdc_mint",
        amount: "1000000",
        uiAmount: "1.0",
        decimals: 6,
      },
    ]);
    createSigningServiceMock.mockImplementation((envArg) => {
      const service = actualCreateSigningService(envArg);
      service.getPublicKey = vi.fn(async (_organizationId, _projectId, walletId) => {
        if (walletId === "para_wallet_a") {
          return address(TEST_SOLANA_ADDRESSES.wallet2);
        }
        if (walletId === "privy_wallet_a") {
          return address(TEST_SOLANA_ADDRESSES.wallet1);
        }
        return address(TEST_SOLANA_ADDRESSES.wallet1);
      });
      return service;
    });

    await seedTestDatabase(env);
    await seedAuthAndConfigs();
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
    createSigningServiceMock.mockReset();
    getAccountInfoMock.mockReset();
    getSplTokenBalancesMock.mockReset();
  });

  it("filters listed wallets to the API key bindings", async () => {
    await seedCachedKey({
      walletBindings: [{ walletId: "para_wallet_a", permissions: ["wallets:read"] }],
    });

    const res = await app.request(
      "/v1/wallets?includeAllProviders=true",
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
        wallets: Array<{ walletId: string }>;
      };
    };
    expect(body.data.wallets.map((wallet) => wallet.walletId)).toEqual(["para_wallet_a"]);
  });

  it("excludes bound wallets that lack wallets:read from the summary view", async () => {
    await seedCachedKey({
      walletBindings: [{ walletId: "para_wallet_a", permissions: ["wallets:write"] }],
    });

    const res = await app.request(
      "/v1/wallets?includeAllProviders=true&view=summary",
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
        wallets: Array<{ walletId: string }>;
      };
    };
    expect(body.data.wallets).toEqual([]);
  });

  it("returns summary wallets without hydrating balances", async () => {
    const res = await app.request(
      "/v1/wallets?includeAllProviders=true&view=summary",
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
        wallets: Array<{ walletId: string; balances?: unknown[] }>;
      };
    };

    expect(body.data.wallets).toHaveLength(3);
    expect(body.data.wallets.every((wallet) => wallet.balances === undefined)).toBe(true);
    expect(getAccountInfoMock).not.toHaveBeenCalled();
    expect(getSplTokenBalancesMock).not.toHaveBeenCalled();
  });

  it("filters aggregate wallets to the API key bindings", async () => {
    await seedCachedKey({
      walletBindings: [{ walletId: "privy_wallet_b", permissions: ["wallets:read"] }],
    });

    const res = await app.request(
      "/v1/wallets/aggregate?includeAllProviders=true",
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
        aggregate: {
          walletCount: number;
          balances: Array<{ token: string; uiAmount: string; usdValue?: number }>;
        };
      };
    };
    expect(body.data.aggregate.walletCount).toBe(1);
    expect(body.data.aggregate.balances).toHaveLength(2);
    expect(body.data.aggregate.balances.find((balance) => balance.token === "USDC")).toMatchObject({
      token: "USDC",
      uiAmount: "1",
      usdValue: 1,
    });
  });

  it("returns the requested public key when the wallet is authorized", async () => {
    await seedCachedKey({
      walletBindings: [{ walletId: "para_wallet_a", permissions: ["wallets:read"] }],
    });

    const res = await app.request(
      "/v1/wallets/public-key?walletId=para_wallet_a",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { publicKey: string } };
    expect(body.data.publicKey).toBe(TEST_SOLANA_ADDRESSES.wallet2);
  });

  it("returns 404 when the requested wallet is outside the API key bindings", async () => {
    await seedCachedKey({
      walletBindings: [{ walletId: "privy_wallet_a", permissions: ["wallets:read"] }],
    });

    const res = await app.request(
      "/v1/wallets/public-key?walletId=para_wallet_a",
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

  it("updates the label when the wallet is inside the API key bindings", async () => {
    await seedCachedKey({
      walletBindings: [{ walletId: "para_wallet_a", permissions: ["wallets:write"] }],
    });

    const res = await app.request(
      "/v1/wallets/para_wallet_a",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          label: "Operations",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        wallet: {
          walletId: string;
          label: string | null;
        };
      };
    };
    expect(body.data.wallet).toMatchObject({
      walletId: "para_wallet_a",
      label: "Operations",
    });

    const updated = await getDb(env)
      .prepare("SELECT label FROM custody_wallets WHERE wallet_id = ? LIMIT 1")
      .bind("para_wallet_a")
      .first<{ label: string | null }>();

    expect(updated?.label).toBe("Operations");
  });

  it("returns 404 when updating a wallet outside the API key bindings", async () => {
    await seedCachedKey({
      walletBindings: [{ walletId: "privy_wallet_a", permissions: ["wallets:write"] }],
    });

    const res = await app.request(
      "/v1/wallets/para_wallet_a",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          label: "Operations",
        }),
      },
      env
    );

    expect(res.status).toBe(404);
  });

  it("excludes custody configs from a different project in the same org", async () => {
    const otherProjectId = "prj_custody_config_cross_project";
    const otherConfigId = "cust_cfg_scope_other_project";

    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          otherProjectId,
          TEST_ORG.id,
          "Other Config Project",
          "other-config-project",
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
          "turnkey",
          "test-config",
          "sdp-custody-encryption-v1",
          "turnkey_wallet_other",
          "active"
        ),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, label, purpose, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          "cwlt_scope_other_project",
          otherConfigId,
          "turnkey_wallet_other",
          "turnkey_pubkey_other",
          "Other",
          "root",
          "active"
        ),
    ]);

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
    const configIds = body.data.configs.map((config) => config.id);
    expect(configIds).toContain(PRIVY_CONFIG_ID);
    expect(configIds).toContain(PARA_CONFIG_ID);
    expect(configIds).not.toContain(otherConfigId);
  });
});
