import app from "@/index";
import { hashString } from "@/lib/hash";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/d1";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/solana/rpc", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/solana/rpc")>("@/services/solana/rpc");

  return {
    ...actual,
    createRpc: vi.fn().mockReturnValue({}),
    getAccountInfo: vi.fn().mockResolvedValue({
      lamports: 4200000000n,
    }),
  };
});

const TEST_ORG = {
  id: "org_custody_wallet_by_id",
  name: "Custody Wallet By ID Org",
  slug: "custody-wallet-by-id-org",
};

const TEST_USER = {
  id: "usr_custody_wallet_by_id",
  email: "custody-wallet-by-id@example.com",
};

const TEST_API_KEY = {
  id: "key_custody_wallet_by_id",
  // biome-ignore lint/nursery/noSecrets: Test fixture only.
  raw: "sk_test_custodywalletbyid1234567890",
  prefix: "sk_test_wal",
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

const PRIVY_CONFIG_ID = "cust_cfg_wallet_by_id_privy";
const PARA_CONFIG_ID = "cust_cfg_wallet_by_id_para";

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
      "Custody Wallet By ID Test Key",
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
    ).bind("csd_wallet_by_id_org_default", TEST_ORG.id, null, PRIVY_CONFIG_ID),
    env.DB.prepare(
      `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      "cwlt_wallet_by_id_privy_a",
      PRIVY_CONFIG_ID,
      "privy_wallet_a",
      TEST_SOLANA_ADDRESSES.wallet1,
      "Privy Wallet A",
      "root",
      "active"
    ),
    env.DB.prepare(
      `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
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

describe("Custody wallet by ID route", () => {
  beforeEach(async () => {
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
});
