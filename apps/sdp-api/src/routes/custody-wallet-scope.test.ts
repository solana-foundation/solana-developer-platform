import { hashString } from "@sdp/payments/hash";
import * as rpcRelay from "@sdp/rpc/relay";
import * as solanaRpc from "@sdp/rpc/solana";
import type { CachedApiKey } from "@sdp/types";
import { address, blockhash, generateKeyPairSigner, signature } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import app from "@/index";
import { clearWalletCaches } from "@/routes/custody/handlers/wallets";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import * as signingServiceModule from "@/services/domain/signing.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const signerCheckMocks = vi.hoisted(() => ({
  createOrgSigner: vi.fn(),
  createSponsorship: vi.fn(),
  signAndSend: vi.fn(),
}));

vi.mock("@/services/solana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/solana")>()),
  createOrgSigner: signerCheckMocks.createOrgSigner,
}));

vi.mock("@/services/sponsorship.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/sponsorship.service")>()),
  createAuthenticatedSponsorshipFeePayment: signerCheckMocks.createSponsorship,
}));

const actualCreateSigningService = signingServiceModule.createSigningService;
const createRpcMock = vi.spyOn(solanaRpc, "createRpc");
const getAccountInfoMock = vi.spyOn(solanaRpc, "getAccountInfo");
const getSplTokenBalancesMock = vi.spyOn(tokenAccounts, "getSplTokenBalances");
const createSigningServiceMock = vi.spyOn(signingServiceModule, "createSigningService");
const resolveRpcTargetMock = vi.spyOn(rpcRelay, "resolveRpcTarget");
const getRecentBlockhashMock = vi.spyOn(solanaRpc, "getRecentBlockhash");
const confirmTransactionMock = vi.spyOn(solanaRpc, "confirmTransaction");

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

const TEST_SESSION_ID = "ses_custody_wallet_scope";
const TEST_SIGNATURE = signature("1".repeat(64));

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
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'admin', 'active')`
      )
      .bind("om_custody_wallet_scope", TEST_ORG.id, TEST_USER.id),
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
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, 'admin')`
      )
      .bind("pm_custody_wallet_scope", TEST_PROJECT.id, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
         VALUES (?, ?, ?, 'session', ?)`
      )
      .bind(TEST_SESSION_ID, TEST_USER.id, TEST_ORG.id, "2099-01-01T00:00:00.000Z"),
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
  const walletBindings = override.walletBindings
    ? await Promise.all(
        override.walletBindings.map(async (binding) => {
          if (binding.custodyWalletId) {
            return binding;
          }
          const wallet = await getDb(env)
            .prepare("SELECT id FROM custody_wallets WHERE wallet_id = ? LIMIT 1")
            .bind(binding.walletId)
            .first<{ id: string }>();
          return { ...binding, custodyWalletId: wallet?.id ?? binding.walletId };
        })
      )
    : undefined;
  await seedCachedApiKey(env, keyHash, {
    ...TEST_CACHED_API_KEY,
    ...override,
    ...(walletBindings ? { walletBindings } : {}),
  });
}

async function seedActiveConnectionWallet(
  suffix: string,
  walletId: string,
  publicKey: string
): Promise<void> {
  const credentialId = `pcred_scope_${suffix}`;
  const connectionId = `cconn_scope_${suffix}`;
  const walletRecordId = `cwlt_scope_${suffix}`;

  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO provider_credentials (
           id, organization_id, project_id, provider, label, scope, source,
           storage_backend, encrypted_secret_payload, status, created_by
         ) VALUES (?, ?, ?, 'privy', ?, 'project', 'stored',
                   'encrypted_db', 'not-read', 'active', ?)`
      )
      .bind(credentialId, TEST_ORG.id, TEST_PROJECT.id, suffix, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO custody_connections (
           id, organization_id, project_id, provider, scope,
           provider_credential_id, provider_credential_scope_key, status, created_by
         ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'pending', ?)`
      )
      .bind(
        connectionId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        credentialId,
        TEST_PROJECT.id,
        TEST_USER.id
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_connection_id, wallet_id, public_key, status
         ) VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(walletRecordId, connectionId, walletId, publicKey),
    getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET default_custody_wallet_id = ?, status = 'active',
             last_check_status = 'success', last_check_at = sdp_iso_now(),
             provider_account_fingerprint = ?, activated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(walletRecordId, `sha256:${suffix}`, connectionId),
  ]);
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
    resolveRpcTargetMock.mockResolvedValue({
      providerId: "default",
      projectId: TEST_PROJECT.id,
      endpoint: "https://solana-rpc.mock.invalid",
      endpointLabel: "test",
      headers: {},
      selectionMode: "round_robin_default",
    });
    getRecentBlockhashMock.mockResolvedValue({
      blockhash: blockhash("1".repeat(32)),
      lastValidBlockHeight: 1_000n,
    });
    confirmTransactionMock.mockResolvedValue({
      signature: TEST_SIGNATURE,
      slot: 100n,
      confirmationStatus: "confirmed",
      err: null,
    });
    signerCheckMocks.createOrgSigner.mockResolvedValue(await generateKeyPairSigner());
    signerCheckMocks.signAndSend.mockResolvedValue(TEST_SIGNATURE);
    signerCheckMocks.createSponsorship.mockReturnValue({
      providerId: "test",
      getFeePayer: vi.fn().mockResolvedValue(address(TEST_SOLANA_ADDRESSES.wallet3)),
      signAsFeePayer: vi.fn(),
      signAndSend: signerCheckMocks.signAndSend,
    });
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
    await clearKVStores(env);
    createSigningServiceMock.mockReset();
    getAccountInfoMock.mockReset();
    getSplTokenBalancesMock.mockReset();
  });

  it("resolves the API key's bound wallet when walletId is omitted", async () => {
    await seedCachedKey({
      signingWalletId: "privy_wallet_a",
      walletBindings: [{ walletId: "privy_wallet_a", permissions: ["wallets:write"] }],
    });

    const response = await app.request(
      "/v1/wallets/signer-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({}),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { walletId: "privy_wallet_a", signature: TEST_SIGNATURE },
    });
    expect(signerCheckMocks.createOrgSigner).toHaveBeenCalledWith(
      env,
      TEST_ORG.id,
      TEST_PROJECT.id,
      "privy_wallet_a"
    );
  });

  it("requires walletId for a session-authenticated signer check", async () => {
    const response = await app.request(
      "/v1/wallets/signer-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `sdp_session=${TEST_SESSION_ID}`,
          "x-project-id": TEST_PROJECT.id,
        },
        body: JSON.stringify({}),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message: "walletId is required for session or Clerk authentication",
      },
    });
    expect(signerCheckMocks.createOrgSigner).not.toHaveBeenCalled();
  });

  it("generates the memo for a session request and strips a caller memo", async () => {
    const callerMemo = "caller-controlled memo";
    const response = await app.request(
      "/v1/wallets/signer-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `sdp_session=${TEST_SESSION_ID}`,
          "x-project-id": TEST_PROJECT.id,
        },
        body: JSON.stringify({ walletId: "privy_wallet_a", memo: callerMemo }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = z
      .object({ data: z.object({ memo: z.string(), walletId: z.string() }) })
      .parse(await response.json());
    expect(body.data.walletId).toBe("privy_wallet_a");
    expect(body.data.memo).toMatch(
      /^SDP signer check [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(body.data.memo).not.toBe(callerMemo);
    expect(signerCheckMocks.createOrgSigner).toHaveBeenCalledWith(
      env,
      TEST_ORG.id,
      TEST_PROJECT.id,
      "privy_wallet_a"
    );
    expect(signerCheckMocks.createSponsorship).toHaveBeenCalledOnce();
  });

  it("executes signer check without consulting a denying wallet policy", async () => {
    await seedCachedKey({
      signingWalletId: "privy_wallet_a",
      walletBindings: [{ walletId: "privy_wallet_a", permissions: ["wallets:write"] }],
    });
    await getDb(env)
      .prepare("UPDATE custody_configs SET project_id = ? WHERE id = ?")
      .bind(TEST_PROJECT.id, PRIVY_CONFIG_ID)
      .run();
    const policyResponse = await app.request(
      "/v1/payments/wallets/privy_wallet_a/policies",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          defaultAction: "deny",
          rules: [{ id: "deny-everything", kind: "always", action: "deny" }],
        }),
      },
      env
    );
    expect(policyResponse.status).toBe(200);

    const response = await app.request(
      "/v1/wallets/signer-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ walletId: "privy_wallet_a" }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(signerCheckMocks.signAndSend).toHaveBeenCalledOnce();

    const operationCount = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM wallet_operations")
      .first<{ count: number }>();
    expect(operationCount).toEqual({ count: 0 });
  });

  it("rate-limits the third signer check by the same actor", async () => {
    await seedCachedKey({
      signingWalletId: "privy_wallet_a",
      walletBindings: [{ walletId: "privy_wallet_a", permissions: ["wallets:write"] }],
    });

    const request = () =>
      app.request(
        "/v1/wallets/signer-check",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ walletId: "privy_wallet_a" }),
        },
        env
      );

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    const blocked = await request();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(signerCheckMocks.signAndSend).toHaveBeenCalledTimes(2);
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

  it("omits and does not cache balances when an RPC leg fails", async () => {
    clearWalletCaches();
    getSplTokenBalancesMock.mockRejectedValue(new Error("temporary RPC failure"));

    const request = () =>
      app.request(
        "/v1/wallets?includeAllProviders=true&view=summary&includeBalances=true",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request();
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { wallets: Array<{ balances?: unknown[] }> };
      };
      expect(body.data.wallets).toHaveLength(3);
      expect(body.data.wallets.every((wallet) => wallet.balances === undefined)).toBe(true);
    }

    // Every retry re-observes every wallet instead of replaying synthetic zeros
    // from the short-lived balance cache.
    expect(getSplTokenBalancesMock).toHaveBeenCalledTimes(6);
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

  it("keeps balances distinct when two Connections share a Provider wallet ID", async () => {
    const sharedWalletId = "privy_shared_provider_wallet";
    for (const [suffix, publicKey] of [
      ["a", TEST_SOLANA_ADDRESSES.wallet2],
      ["b", TEST_SOLANA_ADDRESSES.wallet3],
    ] as const) {
      const credentialId = `pcred_scope_shared_${suffix}`;
      const connectionId = `cconn_scope_shared_${suffix}`;
      const walletRecordId = `cwlt_scope_shared_${suffix}`;
      await getDb(env).batch([
        getDb(env)
          .prepare(
            `INSERT INTO provider_credentials (
               id, organization_id, project_id, provider, label, scope, source,
               storage_backend, encrypted_secret_payload, status, created_by
             ) VALUES (?, ?, ?, 'privy', ?, 'project', 'stored',
                       'encrypted_db', 'not-read', 'active', ?)`
          )
          .bind(credentialId, TEST_ORG.id, TEST_PROJECT.id, suffix, TEST_USER.id),
        getDb(env)
          .prepare(
            `INSERT INTO custody_connections (
               id, organization_id, project_id, provider, scope,
               provider_credential_id, provider_credential_scope_key, status, created_by
             ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'pending', ?)`
          )
          .bind(
            connectionId,
            TEST_ORG.id,
            TEST_PROJECT.id,
            credentialId,
            TEST_PROJECT.id,
            TEST_USER.id
          ),
        getDb(env)
          .prepare(
            `INSERT INTO custody_wallets (
               id, custody_connection_id, wallet_id, public_key, status
             ) VALUES (?, ?, ?, ?, 'active')`
          )
          .bind(walletRecordId, connectionId, sharedWalletId, publicKey),
        getDb(env)
          .prepare(
            `UPDATE custody_connections
             SET default_custody_wallet_id = ?, status = 'active',
                 last_check_status = 'success', last_check_at = sdp_iso_now(),
                 provider_account_fingerprint = ?,
                 activated_at = sdp_iso_now()
             WHERE id = ?`
          )
          .bind(walletRecordId, `sha256:${suffix}`, connectionId),
      ]);
    }
    getSplTokenBalancesMock.mockResolvedValue([]);
    getAccountInfoMock.mockImplementation(
      async (_rpc, publicKey) =>
        ({
          lamports:
            publicKey === TEST_SOLANA_ADDRESSES.wallet2
              ? 1_000_000_000n
              : publicKey === TEST_SOLANA_ADDRESSES.wallet3
                ? 2_000_000_000n
                : 0n,
          owner: "11111111111111111111111111111111",
        }) as Awaited<ReturnType<typeof solanaRpc.getAccountInfo>>
    );

    const response = await app.request(
      "/v1/wallets/aggregate?includeAllProviders=true",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        aggregate: {
          walletCount: number;
          balances: Array<{ token: string; uiAmount: string }>;
        };
      };
    };
    expect(body.data.aggregate.walletCount).toBe(5);
    expect(body.data.aggregate.balances.find((balance) => balance.token === "SOL")).toMatchObject({
      uiAmount: "3",
    });

    await seedCachedKey({
      walletScope: "selected",
      signingWalletId: sharedWalletId,
      walletBindings: [
        {
          walletId: sharedWalletId,
          custodyWalletId: "cwlt_scope_shared_a",
          permissions: ["*"],
        },
      ],
    });

    const selectedList = await app.request(
      "/v1/wallets?includeAllProviders=true",
      {
        headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
      },
      env
    );
    expect(selectedList.status).toBe(200);
    const selectedListBody = (await selectedList.json()) as {
      data: { wallets: Array<{ id: string }> };
    };
    expect(selectedListBody.data.wallets.map((wallet) => wallet.id)).toEqual([
      "cwlt_scope_shared_a",
    ]);

    const selectedDetail = await app.request(
      `/v1/wallets/${sharedWalletId}?includeBalance=false`,
      {
        headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
      },
      env
    );
    expect(selectedDetail.status).toBe(200);
    expect(await selectedDetail.json()).toMatchObject({
      data: { wallet: { id: "cwlt_scope_shared_a", publicKey: TEST_SOLANA_ADDRESSES.wallet2 } },
    });

    const selectedPublicKey = await app.request(
      `/v1/wallets/public-key?walletId=${sharedWalletId}`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(selectedPublicKey.status).toBe(200);
    expect(await selectedPublicKey.json()).toMatchObject({
      data: { publicKey: TEST_SOLANA_ADDRESSES.wallet2 },
    });

    const selectedBalances = await app.request(
      `/v1/payments/wallets/${sharedWalletId}/balances`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(selectedBalances.status).toBe(200);

    const selectedDelete = await app.request(
      "/v1/wallets",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ walletId: sharedWalletId, provider: "privy" }),
      },
      env
    );
    expect(selectedDelete.status).toBe(400);
    expect(await selectedDelete.json()).toMatchObject({
      error: { message: "Wallet deletion not supported for provider: privy" },
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
    expect(body.data.publicKey).toBe("para_pubkey_a");
  });

  it("rejects custody record IDs on public command selectors", async () => {
    await seedCachedKey({
      walletScope: "selected",
      signingWalletId: "para_wallet_a",
      walletBindings: [
        {
          walletId: "para_wallet_a",
          custodyWalletId: "cwlt_scope_para_a",
          permissions: ["wallets:read"],
        },
      ],
    });

    const requests = [
      ["/v1/wallets/public-key?walletId=cwlt_scope_para_a", 404],
      ["/v1/payments/wallets/cwlt_scope_para_a/balances", 403],
      ["/v1/payments/wallets/cwlt_scope_para_a/policies", 403],
    ] as const;

    for (const [path, expectedStatus] of requests) {
      const response = await app.request(
        path,
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );
      expect(response.status).toBe(expectedStatus);
    }
  });

  it("keeps the custody record ID alias for exact wallet GET and PATCH", async () => {
    await seedCachedKey({
      walletScope: "selected",
      signingWalletId: "para_wallet_a",
      walletBindings: [
        {
          walletId: "para_wallet_a",
          custodyWalletId: "cwlt_scope_para_a",
          permissions: ["wallets:read", "wallets:write"],
        },
      ],
    });

    const detail = await app.request(
      "/v1/wallets/cwlt_scope_para_a?includeBalance=false",
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      data: { wallet: { id: "cwlt_scope_para_a", walletId: "para_wallet_a" } },
    });

    const update = await app.request(
      "/v1/wallets/cwlt_scope_para_a",
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ label: "Alias update" }),
      },
      env
    );
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      data: { wallet: { id: "cwlt_scope_para_a", label: "Alias update" } },
    });
  });

  it("returns 409 when an exact wallet selector matches a canonical ID and record-ID alias", async () => {
    await seedCachedKey({
      walletScope: "selected",
      signingWalletId: "para_wallet_a",
      walletBindings: [
        {
          walletId: "para_wallet_a",
          custodyWalletId: "cwlt_scope_para_a",
          permissions: ["wallets:read", "wallets:write"],
        },
      ],
    });
    await getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES ('para_wallet_a', ?, 'para_alias_collision', ?, 'active')`
      )
      .bind(PARA_CONFIG_ID, TEST_SOLANA_ADDRESSES.wallet3)
      .run();

    const detail = await app.request(
      "/v1/wallets/para_wallet_a?includeBalance=false",
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(detail.status).toBe(409);

    const update = await app.request(
      "/v1/wallets/para_wallet_a",
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
  });

  it("does not expose a canonical and record-ID collision outside the key bindings", async () => {
    await seedCachedKey({
      walletScope: "selected",
      signingWalletId: "para_wallet_a",
      walletBindings: [
        {
          walletId: "para_wallet_a",
          custodyWalletId: "cwlt_scope_para_a",
          permissions: ["wallets:read", "wallets:write"],
        },
      ],
    });
    await getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES ('privy_wallet_a', ?, 'privy_alias_unbound', ?, 'active')`
      )
      .bind(PRIVY_CONFIG_ID, TEST_SOLANA_ADDRESSES.wallet3)
      .run();

    const detail = await app.request(
      "/v1/wallets/privy_wallet_a?includeBalance=false",
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(detail.status).toBe(404);

    const update = await app.request(
      "/v1/wallets/privy_wallet_a",
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ label: "Hidden" }),
      },
      env
    );
    expect(update.status).toBe(404);
  });

  it("fails closed when a selected wallet ID becomes ambiguous", async () => {
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted,
              encryption_version, default_wallet_id, status)
           VALUES ('cust_cfg_scope_privy_project', ?, ?, 'privy', 'test-config',
                   'sdp-custody-encryption-v1', 'privy_wallet_a', 'active')`
        )
        .bind(TEST_ORG.id, TEST_PROJECT.id),
      getDb(env).prepare(
        `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, status)
           VALUES ('cwlt_scope_privy_project', 'cust_cfg_scope_privy_project',
                   'privy_wallet_a', 'project_duplicate_pubkey', 'active')`
      ),
      getDb(env)
        .prepare(
          `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
           VALUES ('akw_scope_ambiguous', ?, 'privy_wallet_a', '["wallets:read"]')`
        )
        .bind(TEST_API_KEY.id),
    ]);
    await clearKVStores(env);

    const response = await app.request(
      "/v1/wallets/public-key?walletId=privy_wallet_a",
      {
        headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
      },
      env
    );

    expect(response.status).toBe(404);
  });

  it("fails closed when Config and Connection wallets share a selected wallet ID", async () => {
    await seedActiveConnectionWallet(
      "config_connection_ambiguous",
      "privy_wallet_a",
      "connection_duplicate_pubkey"
    );
    await getDb(env)
      .prepare(
        `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES ('akw_scope_cross_model_ambiguous', ?, 'privy_wallet_a', '["wallets:read"]')`
      )
      .bind(TEST_API_KEY.id)
      .run();
    await clearKVStores(env);

    const response = await app.request(
      "/v1/wallets/public-key?walletId=privy_wallet_a",
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(response.status).toBe(404);
  });

  it("keeps a legacy signing wallet selected only while it resolves uniquely", async () => {
    await getDb(env)
      .prepare("UPDATE api_keys SET signing_wallet_id = 'privy_wallet_b' WHERE id = ?")
      .bind(TEST_API_KEY.id)
      .run();

    const listWalletIds = async (): Promise<string[]> => {
      await clearKVStores(env);
      const response = await app.request(
        "/v1/wallets?includeAllProviders=true&view=summary",
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { wallets: Array<{ walletId: string }> };
      };
      return body.data.wallets.map((wallet) => wallet.walletId);
    };

    expect(await listWalletIds()).toEqual(["privy_wallet_b"]);

    await seedActiveConnectionWallet(
      "legacy_ambiguous",
      "privy_wallet_b",
      "legacy_duplicate_pubkey"
    );
    expect(await listWalletIds()).toEqual([]);

    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE wallet_id = 'privy_wallet_b'")
      .run();
    expect(await listWalletIds()).toEqual([]);
  });

  it("does not replace an ambiguous preferred wallet during cold or warm auth", async () => {
    await seedActiveConnectionWallet(
      "preferred_ambiguous",
      "privy_wallet_a",
      "preferred_duplicate_pubkey"
    );
    await getDb(env).batch([
      getDb(env)
        .prepare("UPDATE api_keys SET signing_wallet_id = 'privy_wallet_a' WHERE id = ?")
        .bind(TEST_API_KEY.id),
      getDb(env)
        .prepare(
          `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
           VALUES ('akw_scope_preferred_a', ?, 'privy_wallet_a', '["wallets:read"]')`
        )
        .bind(TEST_API_KEY.id),
      getDb(env)
        .prepare(
          `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
           VALUES ('akw_scope_preferred_b', ?, 'privy_wallet_b', '["wallets:read"]')`
        )
        .bind(TEST_API_KEY.id),
    ]);
    await clearKVStores(env);

    const requestPublicKey = (walletId = "") =>
      app.request(
        `/v1/wallets/public-key${walletId ? `?walletId=${walletId}` : ""}`,
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

    expect((await requestPublicKey()).status).toBe(404);
    expect((await requestPublicKey()).status).toBe(404);

    const explicit = await requestPublicKey("privy_wallet_b");
    expect(explicit.status).toBe(200);
    expect(await explicit.json()).toMatchObject({ data: { publicKey: "privy_pubkey_b" } });
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

  it("prevents a project-scoped caller from changing an organization default wallet", async () => {
    const res = await app.request(
      "/v1/wallets/default-wallet",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "privy",
          walletId: "privy_wallet_b",
        }),
      },
      env
    );

    expect(res.status).toBe(409);
    const config = await getDb(env)
      .prepare("SELECT default_wallet_id FROM custody_configs WHERE id = ?")
      .bind(PRIVY_CONFIG_ID)
      .first<{ default_wallet_id: string | null }>();
    expect(config?.default_wallet_id).toBe("privy_wallet_a");
  });

  it("prevents a project-scoped caller from deleting an organization wallet", async () => {
    const res = await app.request(
      "/v1/wallets",
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "privy",
          walletId: "privy_wallet_b",
        }),
      },
      env
    );

    expect(res.status).toBe(404);
    const wallet = await getDb(env)
      .prepare("SELECT status FROM custody_wallets WHERE wallet_id = ?")
      .bind("privy_wallet_b")
      .first<{ status: string }>();
    expect(wallet?.status).toBe("active");
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

  describe("wallet-scoped key lifecycle mutations", () => {
    let originalPrivyAppId: string | undefined;
    let originalPrivyAppSecret: string | undefined;

    beforeEach(() => {
      originalPrivyAppId = env.PRIVY_APP_ID;
      originalPrivyAppSecret = env.PRIVY_APP_SECRET;
      env.PRIVY_APP_ID = "privy_test_app_id";
      env.PRIVY_APP_SECRET = "privy_test_app_secret";
    });

    afterEach(() => {
      env.PRIVY_APP_ID = originalPrivyAppId;
      env.PRIVY_APP_SECRET = originalPrivyAppSecret;
    });

    it("lets a wallet-scoped key re-default to a wallet inside its bindings", async () => {
      await seedCachedKey({
        projectId: undefined,
        walletBindings: [{ walletId: "privy_wallet_b", permissions: ["wallets:write"] }],
      });

      const res = await app.request(
        "/v1/wallets/default-wallet",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            provider: "privy",
            walletId: "privy_wallet_b",
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const config = await getDb(env)
        .prepare("SELECT default_wallet_id FROM custody_configs WHERE id = ?")
        .bind(PRIVY_CONFIG_ID)
        .first<{ default_wallet_id: string | null }>();
      expect(config?.default_wallet_id).toBe("privy_wallet_b");
    });

    it("masks re-defaulting to a wallet outside the key bindings as unknown", async () => {
      await seedCachedKey({
        projectId: undefined,
        walletBindings: [{ walletId: "privy_wallet_a", permissions: ["wallets:write"] }],
      });

      const res = await app.request(
        "/v1/wallets/default-wallet",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            provider: "privy",
            walletId: "privy_wallet_b",
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const config = await getDb(env)
        .prepare("SELECT default_wallet_id FROM custody_configs WHERE id = ?")
        .bind(PRIVY_CONFIG_ID)
        .first<{ default_wallet_id: string | null }>();
      expect(config?.default_wallet_id).toBe("privy_wallet_a");
    });

    it("returns 404 when a wallet-scoped key deletes a wallet outside its bindings", async () => {
      await seedCachedKey({
        projectId: undefined,
        walletBindings: [{ walletId: "privy_wallet_a", permissions: ["wallets:write"] }],
      });

      const res = await app.request(
        "/v1/wallets",
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            provider: "privy",
            walletId: "privy_wallet_b",
          }),
        },
        env
      );

      expect(res.status).toBe(404);
      const wallet = await getDb(env)
        .prepare("SELECT status FROM custody_wallets WHERE wallet_id = ?")
        .bind("privy_wallet_b")
        .first<{ status: string }>();
      expect(wallet?.status).toBe("active");
    });

    it("lets a bound wallet through the delete binding gate", async () => {
      await seedCachedKey({
        projectId: undefined,
        walletBindings: [{ walletId: "privy_wallet_b", permissions: ["wallets:write"] }],
      });

      const res = await app.request(
        "/v1/wallets",
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            provider: "privy",
            walletId: "privy_wallet_b",
          }),
        },
        env
      );

      // Privy has no wallet deletion: the request passes the binding gate
      // (no masked 404) and fails on provider capability instead.
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(/deletion not supported/i);
    });

    it("rejects wallet creation with a wallet-scoped key", async () => {
      await seedCachedKey({
        projectId: undefined,
        walletBindings: [{ walletId: "privy_wallet_a", permissions: ["*"] }],
      });

      const res = await app.request(
        "/v1/wallets",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ provider: "privy" }),
        },
        env
      );

      expect(res.status).toBe(403);
    });

    it("rejects provider initialization with a wallet-scoped key", async () => {
      await seedCachedKey({
        projectId: undefined,
        walletBindings: [{ walletId: "privy_wallet_a", permissions: ["*"] }],
      });

      const res = await app.request(
        "/v1/wallets/initialize",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ provider: "privy" }),
        },
        env
      );

      expect(res.status).toBe(403);
    });

    it("rejects provider switching with a wallet-scoped key", async () => {
      await seedCachedKey({
        projectId: undefined,
        walletBindings: [{ walletId: "privy_wallet_a", permissions: ["*"] }],
      });

      const res = await app.request(
        "/v1/wallets/switch",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ provider: "para" }),
        },
        env
      );

      expect(res.status).toBe(403);
    });
  });
});
