import app from "@/index";
import { hashString } from "@/lib/hash";
import { createSigningService } from "@/services/domain/signing.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/d1";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";
import type { CachedApiKey, CustodyWalletTokenBalance } from "@sdp/types";
import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/helius-das.service", async () => {
  const actual = await vi.importActual<typeof import("@/services/helius-das.service")>(
    "@/services/helius-das.service"
  );

  return {
    ...actual,
    getTrackedWalletBalancesByOwner: vi.fn(async (_env, owners: string[]) => {
      return new Map<string, CustodyWalletTokenBalance[]>(
        owners.map((owner) => [
          owner,
          [
            {
              token: "USDC",
              mint: "usdc_mint",
              amount: "1000000",
              uiAmount: owner.endsWith("a") ? "1.0" : "2.0",
              decimals: 6,
            },
          ],
        ])
      );
    }),
  };
});

vi.mock("@/services/domain/signing.service", async () => {
  const actual = await vi.importActual<typeof import("@/services/domain/signing.service")>(
    "@/services/domain/signing.service"
  );

  return {
    ...actual,
    createSigningService: vi.fn((envArg) => {
      const service = actual.createSigningService(envArg);
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
    }),
  };
});

const TEST_ORG = {
  id: "org_custody_wallet_scope",
  name: "Custody Wallet Scope Org",
  slug: "custody-wallet-scope-org",
};

const TEST_USER = {
  id: "usr_custody_wallet_scope",
  email: "custody-wallet-scope@example.com",
};

const TEST_API_KEY = {
  id: "key_custody_wallet_scope",
  raw: "sk_test_custodywalletscope12345678901234567890",
  prefix: "sk_test_cws",
};

const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: null,
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

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)"
    ).bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "free", "active"),
    env.DB.prepare(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)"
    ).bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    env.DB.prepare(
      `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, environment, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_API_KEY.id,
      TEST_ORG.id,
      null,
      TEST_USER.id,
      "Custody scope key",
      TEST_API_KEY.prefix,
      keyHash,
      "api_admin",
      JSON.stringify(["*"]),
      "sandbox",
      "active"
    ),
    env.DB.prepare(
      `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      PRIVY_CONFIG_ID,
      TEST_ORG.id,
      null,
      "privy",
      "test-config",
      "sdp-custody-encryption-v1",
      "privy_wallet_a",
      "active"
    ),
    env.DB.prepare(
      `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      PARA_CONFIG_ID,
      TEST_ORG.id,
      null,
      "para",
      "test-config",
      "sdp-custody-encryption-v1",
      "para_wallet_a",
      "active"
    ),
    env.DB.prepare(
      `INSERT INTO custody_scope_defaults
           (id, organization_id, project_id, default_custody_config_id)
         VALUES (?, ?, ?, ?)`
    ).bind("csd_scope_org_default", TEST_ORG.id, null, PRIVY_CONFIG_ID),
    env.DB.prepare(
      `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      "cwlt_scope_privy_a",
      PRIVY_CONFIG_ID,
      "privy_wallet_a",
      "privy_pubkey_a",
      "A",
      "root",
      "active"
    ),
    env.DB.prepare(
      `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      "cwlt_scope_privy_b",
      PRIVY_CONFIG_ID,
      "privy_wallet_b",
      "privy_pubkey_b",
      "B",
      "transfer",
      "active"
    ),
    env.DB.prepare(
      `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
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
    await seedTestDatabase(env);
    await seedAuthAndConfigs();
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
    vi.mocked(createSigningService).mockClear();
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
          balances: Array<{ token: string; uiAmount: string }>;
        };
      };
    };
    expect(body.data.aggregate.walletCount).toBe(1);
    expect(body.data.aggregate.balances).toHaveLength(1);
    expect(body.data.aggregate.balances[0]).toMatchObject({
      token: "USDC",
      uiAmount: "1",
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

    const updated = await env.DB.prepare(
      "SELECT label FROM custody_wallets WHERE wallet_id = ? LIMIT 1"
    )
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
});
