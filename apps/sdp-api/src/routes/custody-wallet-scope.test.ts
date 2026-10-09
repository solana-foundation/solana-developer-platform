import { hashString } from "@sdp/payments/hash";
import * as solanaRpc from "@sdp/rpc/solana";
import type { CachedApiKey, SignerCheckRequest } from "@sdp/types";
import { address, blockhash, generateKeyPairSigner, signature } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import app from "@/index";
import { clearWalletCaches } from "@/routes/custody/handlers/wallets";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import { upsertApiKeyWalletBinding } from "@/services/api-key-wallets.service";
import * as signingServiceModule from "@/services/domain/signing.service";
import { custodyProviderNotInReleaseChannel } from "@/services/provider-availability.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import {
  insertTestCustodyConfigRow,
  insertTestCustodyWalletRow,
  seedTestCustodyRows,
} from "@/test/helpers/custody";
import { seedTestPrivyConnection } from "@/test/helpers/custody-connections";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const signerCheckMocks = vi.hoisted(() => ({
  createExactSigner: vi.fn(),
  createSponsorship: vi.fn(),
  signAndSend: vi.fn(),
}));

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

vi.mock("@/services/solana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/solana")>()),
  createOrgSignerForCustodyWallet: signerCheckMocks.createExactSigner,
}));

vi.mock("@/services/sponsorship.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/sponsorship.service")>()),
  createAuthenticatedSponsorshipFeePayment: signerCheckMocks.createSponsorship,
}));

const SEEDED_PUBLIC_KEYS = {
  privyA: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
  privyB: "CKmTHyQ4xMzL3dYzzaTBV5BKLjGPYVLPA4Q5DMLRRXUm",
  paraA: "W8En8FoqdjDnMG7kahDRaPT6ZqUY872rkrsR9dReLTg",
};

const actualCreateSigningService = signingServiceModule.createSigningService;
const createRpcMock = vi.spyOn(solanaRpc, "createRpc");
const createClusterRpcMock = vi.spyOn(solanaRpc, "createClusterRpc");
const getAccountInfoMock = vi.spyOn(solanaRpc, "getAccountInfo");
const getMultipleAccountsLamportsMock = vi.spyOn(solanaRpc, "getMultipleAccountsLamports");
const getSplTokenBalancesMock = vi.spyOn(tokenAccounts, "getSplTokenBalances");
const createSigningServiceMock = vi.spyOn(signingServiceModule, "createSigningService");
const getRecentBlockhashMock = vi.spyOn(solanaRpc, "getRecentBlockhash");
const confirmTransactionMock = vi.spyOn(solanaRpc, "confirmTransaction");
const simulateTransactionMock = vi.spyOn(solanaRpc, "simulateTransaction");

const TEST_ORG = {
  id: "org_test_custody_wallet_scope",
  name: "Custody Wallet Scope Org",
  slug: "custody-wallet-scope-org",
};

const TEST_PROJECT = {
  id: "prj_test_custody_wallet_scope",
  slug: "test-custody-wallet-scope-project",
};

const TEST_PRODUCTION_PROJECT_ID = "prj_test_custody_wallet_scope_production";

const TEST_USER = {
  id: "usr_test_custody_wallet_scope",
  email: "custody-wallet-scope@example.com",
};

const TEST_API_KEY = {
  id: "key_custody_wallet_scope",
  raw: "sk_test_custody_wallet_scope",
  prefix: "sk_test_cws",
};

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
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [TEST_USER.id],
    ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT_ID },
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
      "Custody scope key",
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
        id: "cwlt_scope_privy_a",
        owner: { kind: "config", custodyConfigId: PRIVY_CONFIG_ID },
        walletId: "privy_wallet_a",
        publicKey: SEEDED_PUBLIC_KEYS.privyA,
        label: "A",
        purpose: "root",
        status: "active",
      },
      {
        id: "cwlt_scope_privy_b",
        owner: { kind: "config", custodyConfigId: PRIVY_CONFIG_ID },
        walletId: "privy_wallet_b",
        publicKey: SEEDED_PUBLIC_KEYS.privyB,
        label: "B",
        purpose: "transfer",
        status: "active",
      },
      {
        id: "cwlt_scope_para_a",
        owner: { kind: "config", custodyConfigId: PARA_CONFIG_ID },
        walletId: "para_wallet_a",
        publicKey: SEEDED_PUBLIC_KEYS.paraA,
        label: "C",
        purpose: "root",
        status: "active",
      },
    ],
  });
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
          return { ...binding, custodyWalletId: required(wallet).id };
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
  await getDb(env).transaction((tx) =>
    seedTestPrivyConnection(tx, {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      connectionId: `cconn_scope_${suffix}`,
      credentialId: `pcred_scope_${suffix}`,
      createdBy: TEST_USER.id,
      stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "not-read" },
      providerAccountFingerprint: `sha256:${suffix}`,
      lastCheckStatus: "success",
      wallets: [
        {
          id: `cwlt_scope_${suffix}`,
          walletId,
          publicKey,
          label: null,
          purpose: null,
          status: "active",
        },
      ],
      defaultCustodyWalletId: `cwlt_scope_${suffix}`,
    })
  );
}

async function requestSignerCheck(body: SignerCheckRequest, actor: "api_key" | "clerk") {
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-project-id": TEST_PROJECT.id,
  });
  if (actor === "api_key") {
    headers.set("Authorization", `Bearer ${TEST_API_KEY.raw}`);
  } else {
    headers.set(
      "Authorization",
      `Bearer ${await signSeededClerkMember(env, getDb(env), TEST_USER.id, TEST_ORG.id)}`
    );
  }
  return app.request(
    "/v1/wallets/signer-check",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    env
  );
}

describe("Custody wallet scope routes", () => {
  beforeEach(async () => {
    custodyReleaseChannel.outOfChannelMode = null;
    vi.clearAllMocks();

    createRpcMock.mockReturnValue({} as ReturnType<typeof solanaRpc.createRpc>);
    getAccountInfoMock.mockResolvedValue({
      lamports: 0n,
      owner: "11111111111111111111111111111111",
    } as Awaited<ReturnType<typeof solanaRpc.getAccountInfo>>);
    getMultipleAccountsLamportsMock.mockImplementation(async (_rpc, addresses) =>
      addresses.map(() => 0n)
    );
    getSplTokenBalancesMock.mockResolvedValue([
      {
        token: "USDC",
        mint: "usdc_mint",
        amount: "1000000",
        uiAmount: "1.0",
        decimals: 6,
      },
    ]);
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
    simulateTransactionMock.mockResolvedValue({
      success: true,
      logs: [],
      unitsConsumed: null,
      error: null,
    });
    const signer = await generateKeyPairSigner();
    signerCheckMocks.createExactSigner.mockResolvedValue(signer);
    signerCheckMocks.signAndSend.mockResolvedValue(TEST_SIGNATURE);
    signerCheckMocks.createSponsorship.mockReturnValue({
      providerId: "test",
      getFeePayer: vi.fn().mockResolvedValue(address(TEST_SOLANA_ADDRESSES.wallet3)),
      signAsFeePayer: vi.fn(),
      signAndSend: signerCheckMocks.signAndSend,
    });
    createSigningServiceMock.mockImplementation((envArg, scope) => {
      const service = actualCreateSigningService(envArg, scope);
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
    env.SOLANA_MAINNET_RPC_URL = undefined;
    await clearKVStores(env);
    createSigningServiceMock.mockReset();
    getAccountInfoMock.mockReset();
    getMultipleAccountsLamportsMock.mockReset();
    getSplTokenBalancesMock.mockReset();
  });

  it("refuses a signer check whose BYOK pair is out of channel before signer, fee payer, or RPC access", async () => {
    await seedActiveConnectionWallet("signer_check", "privy_check", TEST_SOLANA_ADDRESSES.wallet1);
    custodyReleaseChannel.outOfChannelMode = "byok";

    const response = await requestSignerCheck({ walletId: "privy_check" }, "clerk");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: custodyProviderNotInReleaseChannel("privy", "byok").message,
        details: { reason: "custody_provider_not_in_release_channel" },
      },
      meta: { requestId: expect.any(String) },
    });
    expect(signerCheckMocks.createExactSigner).not.toHaveBeenCalled();
    expect(signerCheckMocks.createSponsorship).not.toHaveBeenCalled();
    expect(createClusterRpcMock).not.toHaveBeenCalled();
    expect(simulateTransactionMock).not.toHaveBeenCalled();
  });

  it("refuses an unavailable signer check before signer, fee payer, or RPC access", async () => {
    await seedActiveConnectionWallet("signer_check", "privy_check", TEST_SOLANA_ADDRESSES.wallet1);
    await getDb(env)
      .prepare(
        "UPDATE provider_credentials SET status = 'retired' WHERE id = 'pcred_scope_signer_check'"
      )
      .run();

    const response = await requestSignerCheck({ walletId: "privy_check" }, "clerk");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: "runtime_execution_unavailable" } },
    });
    expect(signerCheckMocks.createExactSigner).not.toHaveBeenCalled();
    expect(signerCheckMocks.createSponsorship).not.toHaveBeenCalled();
    expect(createClusterRpcMock).not.toHaveBeenCalled();
    expect(simulateTransactionMock).not.toHaveBeenCalled();
  });

  it("checks the exact Connection wallet record it admitted", async () => {
    const signer = await generateKeyPairSigner();
    await seedActiveConnectionWallet("signer_check", "privy_check", signer.address);
    signerCheckMocks.createExactSigner.mockResolvedValue(signer);

    const response = await requestSignerCheck({ walletId: "privy_check" }, "clerk");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { walletId: "privy_check", walletAddress: signer.address, simulated: true },
    });
    expect(signerCheckMocks.createExactSigner).toHaveBeenCalledWith(
      env,
      TEST_ORG.id,
      TEST_PROJECT.id,
      "cwlt_scope_signer_check"
    );
    expect(signerCheckMocks.signAndSend).not.toHaveBeenCalled();
    expect(createClusterRpcMock).toHaveBeenCalledExactlyOnceWith(env, "devnet");
  });

  it.each(["clerk", "api_key"] as const)(
    "refuses ambiguous signer-check Provider IDs for %s callers",
    async (actor) => {
      await upsertApiKeyWalletBinding(getDb(env), TEST_API_KEY.id, {
        walletId: "privy_wallet_a",
        permissions: ["wallets:write"],
      });
      await seedCachedKey({
        signingWalletId: "privy_wallet_a",
        walletBindings: [{ walletId: "privy_wallet_a", permissions: ["wallets:write"] }],
      });

      await seedActiveConnectionWallet(
        "duplicate",
        "privy_wallet_a",
        TEST_SOLANA_ADDRESSES.wallet2
      );

      const response = await requestSignerCheck({ walletId: "privy_wallet_a" }, actor);

      expect(response.status).toBe(actor === "clerk" ? 409 : 403);
      expect(signerCheckMocks.createExactSigner).not.toHaveBeenCalled();
      expect(signerCheckMocks.createSponsorship).not.toHaveBeenCalled();
      expect(createClusterRpcMock).not.toHaveBeenCalled();
      expect(simulateTransactionMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    { actor: "clerk", connectionStatus: "active" },
    { actor: "api_key", connectionStatus: "active" },
    { actor: "selected_key", connectionStatus: "active" },
    { actor: "clerk", connectionStatus: "deactivated" },
  ])(
    "refuses a signer check for $actor with a Config and inactive duplicate in a $connectionStatus Connection",
    async ({ actor, connectionStatus }) => {
      await seedActiveConnectionWallet(
        "inactive_duplicate",
        "privy_wallet_a",
        TEST_SOLANA_ADDRESSES.wallet2
      );
      await getDb(env)
        .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
        .bind("cwlt_scope_inactive_duplicate")
        .run();
      if (connectionStatus === "deactivated") {
        await getDb(env)
          .prepare(
            "UPDATE custody_connections SET status = 'deactivated', deactivated_at = sdp_iso_now() WHERE id = ?"
          )
          .bind("cconn_scope_inactive_duplicate")
          .run();
      }
      if (actor === "selected_key") {
        await upsertApiKeyWalletBinding(getDb(env), TEST_API_KEY.id, {
          walletId: "privy_wallet_a",
          permissions: ["wallets:write"],
        });
        await seedCachedKey({
          signingWalletId: "privy_wallet_a",
          walletBindings: [
            {
              walletId: "privy_wallet_a",
              custodyWalletId: "cwlt_scope_privy_a",
              permissions: ["wallets:write"],
            },
          ],
        });
      }

      const response = await requestSignerCheck(
        { walletId: "privy_wallet_a" },
        actor === "clerk" ? "clerk" : "api_key"
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "CONFLICT", message: "Custody wallet ownership is ambiguous" },
      });
      expect(signerCheckMocks.createExactSigner).not.toHaveBeenCalled();
      expect(signerCheckMocks.createSponsorship).not.toHaveBeenCalled();
      expect(createClusterRpcMock).not.toHaveBeenCalled();
      expect(simulateTransactionMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      environment: "sandbox",
      projectId: TEST_PROJECT.id,
      walletId: "privy_wallet_a",
      cluster: "devnet",
    },
    {
      environment: "production",
      projectId: TEST_PRODUCTION_PROJECT_ID,
      walletId: "privy_wallet_production",
      cluster: "mainnet-beta",
    },
  ] as const)(
    "simulates a $environment project's signer check on $cluster",
    async ({ projectId, walletId, cluster }) => {
      await seedTestCustodyRows(env, {
        configs: [
          {
            id: "cust_cfg_scope_privy_production",
            organizationId: TEST_ORG.id,
            projectId: TEST_PRODUCTION_PROJECT_ID,
            provider: "privy",
            configEncrypted: "test-config",
            status: "active",
          },
        ],
        wallets: [
          {
            id: "cwlt_scope_privy_production",
            owner: { kind: "config", custodyConfigId: "cust_cfg_scope_privy_production" },
            walletId: "privy_wallet_production",
            publicKey: TEST_SOLANA_ADDRESSES.wallet3,
            label: null,
            purpose: "root",
            status: "active",
          },
        ],
      });
      env.SOLANA_MAINNET_RPC_URL = "https://mainnet-rpc.mock.invalid";
      const response = await app.request(
        "/v1/wallets/signer-check",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), TEST_USER.id, TEST_ORG.id)}`,
            "x-project-id": projectId,
          },
          body: JSON.stringify({ walletId }),
        },
        env
      );

      expect(response.status).toBe(200);
      expect(createClusterRpcMock).toHaveBeenCalledExactlyOnceWith(env, cluster);
      expect(simulateTransactionMock).toHaveBeenCalledOnce();
    }
  );

  it("keeps signer-check Config selection when an inactive Config has the same Provider ID", async () => {
    await seedTestCustodyRows(env, {
      configs: [
        {
          id: "cfg_signer_retired",
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
          provider: "turnkey",
          configEncrypted: "not-read",
          status: "inactive",
        },
      ],
      wallets: [
        {
          id: "cwlt_signer_retired",
          owner: { kind: "config", custodyConfigId: "cfg_signer_retired" },
          walletId: "privy_wallet_a",
          publicKey: TEST_SOLANA_ADDRESSES.wallet2,
          label: null,
          purpose: null,
          status: "inactive",
        },
      ],
    });

    const response = await requestSignerCheck({ walletId: "privy_wallet_a" }, "clerk");

    expect(response.status).toBe(200);
    expect(signerCheckMocks.createExactSigner).toHaveBeenCalledWith(
      env,
      TEST_ORG.id,
      TEST_PROJECT.id,
      "cwlt_scope_privy_a"
    );
  });

  it.each(["read-only", "revoked", "expired"])(
    "refuses %s signer-check authorization despite a cached write grant",
    async (state) => {
      await upsertApiKeyWalletBinding(getDb(env), TEST_API_KEY.id, {
        walletId: "privy_wallet_a",
        permissions: ["wallets:write"],
      });
      await seedCachedKey({
        signingWalletId: "privy_wallet_a",
        walletBindings: [{ walletId: "privy_wallet_a", permissions: ["wallets:write"] }],
      });
      if (state === "read-only") {
        await upsertApiKeyWalletBinding(getDb(env), TEST_API_KEY.id, {
          walletId: "privy_wallet_a",
          permissions: ["wallets:read"],
        });
      } else if (state === "revoked") {
        await getDb(env)
          .prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ?")
          .bind(TEST_API_KEY.id)
          .run();
      } else {
        await getDb(env)
          .prepare("UPDATE api_keys SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
          .bind(TEST_API_KEY.id)
          .run();
      }

      const response = await requestSignerCheck({ walletId: "privy_wallet_a" }, "api_key");

      expect(response.status).toBe(403);
      expect(signerCheckMocks.createExactSigner).not.toHaveBeenCalled();
      expect(signerCheckMocks.createSponsorship).not.toHaveBeenCalled();
      expect(createClusterRpcMock).not.toHaveBeenCalled();
      expect(simulateTransactionMock).not.toHaveBeenCalled();
    }
  );

  it.each(["privy_missing", "cwlt_scope_privy_a"])(
    "preserves the missing-wallet error for signer-check selector %s",
    async (walletId) => {
      const response = await requestSignerCheck({ walletId }, "clerk");

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "BAD_REQUEST", message: "Custody wallet not found" },
      });
      expect(signerCheckMocks.createExactSigner).not.toHaveBeenCalled();
      expect(signerCheckMocks.createSponsorship).not.toHaveBeenCalled();
      expect(createClusterRpcMock).not.toHaveBeenCalled();
    }
  );

  it("resolves the API key's bound wallet when walletId is omitted", async () => {
    await upsertApiKeyWalletBinding(getDb(env), TEST_API_KEY.id, {
      walletId: "privy_wallet_a",
      permissions: ["wallets:write"],
    });
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
    const body = z
      .object({
        data: z.object({
          walletId: z.string(),
          signature: z.string().min(1),
          simulated: z.literal(true),
        }),
      })
      .parse(await response.json());
    expect(body.data.walletId).toBe("privy_wallet_a");
    expect(signerCheckMocks.createExactSigner).toHaveBeenCalledWith(
      env,
      TEST_ORG.id,
      TEST_PROJECT.id,
      "cwlt_scope_privy_a"
    );

    expect(simulateTransactionMock).toHaveBeenCalledOnce();
    expect(signerCheckMocks.signAndSend).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "single binding",
      walletIds: ["privy_wallet_b"],
      preferred: null,
      status: 200,
      walletId: "privy_wallet_b",
      recordId: "cwlt_scope_privy_b",
    },
    {
      label: "preferred binding",
      walletIds: ["privy_wallet_a", "privy_wallet_b"],
      preferred: "privy_wallet_b",
      status: 200,
      walletId: "privy_wallet_b",
      recordId: "cwlt_scope_privy_b",
    },
    {
      label: "the auth layer's first-binding fallback",
      walletIds: ["privy_wallet_a", "privy_wallet_b"],
      preferred: null,
      status: 200,
      walletId: "privy_wallet_a",
      recordId: "cwlt_scope_privy_a",
    },
    {
      label: "no bindings",
      walletIds: [],
      preferred: null,
      status: 400,
      walletId: null,
      recordId: null,
    },
  ])(
    "preserves signer-check selection with $label and no walletId",
    async ({ walletIds, preferred, status, walletId, recordId }) => {
      const bindings: NonNullable<CachedApiKey["walletBindings"]> = walletIds.map((walletId) => ({
        walletId,
        permissions: ["wallets:write"],
      }));
      for (const binding of bindings) {
        await upsertApiKeyWalletBinding(getDb(env), TEST_API_KEY.id, binding);
      }
      await getDb(env)
        .prepare("UPDATE api_keys SET signing_wallet_id = ? WHERE id = ?")
        .bind(preferred, TEST_API_KEY.id)
        .run();
      await seedCachedKey({ signingWalletId: preferred, walletBindings: bindings });

      const response = await requestSignerCheck({}, "api_key");

      expect(response.status).toBe(status);
      if (status === 200) {
        expect(await response.json()).toMatchObject({
          data: { walletId, simulated: true },
        });
        expect(signerCheckMocks.createExactSigner).toHaveBeenCalledWith(
          env,
          TEST_ORG.id,
          TEST_PROJECT.id,
          recordId
        );
      } else {
        expect(signerCheckMocks.createExactSigner).not.toHaveBeenCalled();
        expect(signerCheckMocks.createSponsorship).not.toHaveBeenCalled();
        expect(createClusterRpcMock).not.toHaveBeenCalled();
      }
    }
  );

  it("requires walletId for a Clerk-authenticated signer check", async () => {
    const response = await app.request(
      "/v1/wallets/signer-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), TEST_USER.id, TEST_ORG.id)}`,
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
        message: expect.stringContaining("Clerk authentication"),
      },
    });
    expect(signerCheckMocks.createExactSigner).not.toHaveBeenCalled();
  });

  it("generates the memo for a Clerk request and strips a caller memo", async () => {
    const callerMemo = "caller-controlled memo";
    const response = await app.request(
      "/v1/wallets/signer-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), TEST_USER.id, TEST_ORG.id)}`,
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
    expect(signerCheckMocks.createExactSigner).toHaveBeenCalledWith(
      env,
      TEST_ORG.id,
      TEST_PROJECT.id,
      "cwlt_scope_privy_a"
    );
    expect(signerCheckMocks.createSponsorship).toHaveBeenCalledOnce();
  });

  it("executes signer check without consulting a denying wallet policy", async () => {
    await upsertApiKeyWalletBinding(getDb(env), TEST_API_KEY.id, {
      walletId: "privy_wallet_a",
      permissions: ["wallets:write"],
    });
    await seedCachedKey({
      signingWalletId: "privy_wallet_a",
      walletBindings: [{ walletId: "privy_wallet_a", permissions: ["wallets:write"] }],
    });
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
    expect(simulateTransactionMock).toHaveBeenCalledOnce();
    expect(signerCheckMocks.signAndSend).not.toHaveBeenCalled();

    const operationCount = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS count FROM wallet_operations")
      .first<{ count: number }>();
    expect(operationCount).toEqual({ count: 0 });
  });

  it("rate-limits the third signer check by the same actor", async () => {
    await upsertApiKeyWalletBinding(getDb(env), TEST_API_KEY.id, {
      walletId: "privy_wallet_a",
      permissions: ["wallets:write"],
    });
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
    expect(simulateTransactionMock).toHaveBeenCalledTimes(2);
    expect(signerCheckMocks.signAndSend).not.toHaveBeenCalled();
  });

  it("filters listed wallets to the API key bindings", async () => {
    await seedCachedKey({
      walletBindings: [{ walletId: "para_wallet_a", permissions: ["wallets:read"] }],
    });

    const res = await app.request(
      "/v1/wallets",
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
      "/v1/wallets?view=summary",
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
      "/v1/wallets?view=summary",
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
    expect(getMultipleAccountsLamportsMock).not.toHaveBeenCalled();
    expect(getSplTokenBalancesMock).not.toHaveBeenCalled();
  });

  it("reads SOL for every cache-missed wallet in one call", async () => {
    clearWalletCaches();

    const response = await app.request(
      "/v1/wallets?view=summary&includeBalances=true",
      { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(response.status).toBe(200);
    expect(getMultipleAccountsLamportsMock).toHaveBeenCalledTimes(1);
    expect(required(getMultipleAccountsLamportsMock.mock.calls[0])[1]).toHaveLength(3);
    expect(getAccountInfoMock).not.toHaveBeenCalled();
  });

  it("omits and does not cache balances when an RPC leg fails", async () => {
    clearWalletCaches();
    getSplTokenBalancesMock.mockRejectedValue(new Error("temporary RPC failure"));

    const request = () =>
      app.request(
        "/v1/wallets?view=summary&includeBalances=true",
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

    expect(getSplTokenBalancesMock).toHaveBeenCalledTimes(6);
  });

  it("refuses an incomplete aggregate and recovers after the missing wallet can be read", async () => {
    clearWalletCaches();
    getSplTokenBalancesMock.mockRejectedValueOnce(new Error("temporary RPC failure"));
    const request = () =>
      app.request(
        "/v1/wallets/aggregate",
        { method: "GET", headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );
    const incomplete = await request();
    expect(incomplete.status).toBe(503);
    expect(await incomplete.json()).not.toHaveProperty("data.aggregate");
    const recovered = await request();
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ data: { aggregate: { walletCount: 3 } } });

    expect(getSplTokenBalancesMock).toHaveBeenCalledTimes(4);
  });

  it("filters aggregate wallets to the API key bindings", async () => {
    await seedCachedKey({
      walletBindings: [{ walletId: "privy_wallet_b", permissions: ["wallets:read"] }],
    });

    const res = await app.request(
      "/v1/wallets/aggregate",
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
      await seedActiveConnectionWallet(`shared_${suffix}`, sharedWalletId, publicKey);
    }
    getSplTokenBalancesMock.mockResolvedValue([]);
    getMultipleAccountsLamportsMock.mockImplementation(async (_rpc, addresses) =>
      addresses.map((publicKey) =>
        publicKey === TEST_SOLANA_ADDRESSES.wallet2
          ? 1_000_000_000n
          : publicKey === TEST_SOLANA_ADDRESSES.wallet3
            ? 2_000_000_000n
            : 0n
      )
    );

    const response = await app.request(
      "/v1/wallets/aggregate",
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
      "/v1/wallets",
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
    expect(body.data.publicKey).toBe(SEEDED_PUBLIC_KEYS.paraA);
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
    await insertTestCustodyWalletRow(getDb(env), {
      id: "para_wallet_a",
      owner: { kind: "config", custodyConfigId: PARA_CONFIG_ID },
      walletId: "para_alias_collision",
      publicKey: TEST_SOLANA_ADDRESSES.wallet3,
      label: null,
      purpose: null,
      status: "active",
    });

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
    await insertTestCustodyWalletRow(getDb(env), {
      id: "privy_wallet_a",
      owner: { kind: "config", custodyConfigId: PRIVY_CONFIG_ID },
      walletId: "privy_alias_unbound",
      publicKey: TEST_SOLANA_ADDRESSES.wallet3,
      label: null,
      purpose: null,
      status: "active",
    });

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
    await getDb(env).transaction(async (tx) => {
      await insertTestCustodyConfigRow(tx, {
        id: "cust_cfg_scope_turnkey_project",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        provider: "turnkey",
        configEncrypted: "test-config",
        status: "active",
      });
      await insertTestCustodyWalletRow(tx, {
        id: "cwlt_scope_turnkey_project",
        owner: { kind: "config", custodyConfigId: "cust_cfg_scope_turnkey_project" },
        walletId: "privy_wallet_a",
        publicKey: "project_duplicate_pubkey",
        label: null,
        purpose: null,
        status: "active",
      });
      await tx.execute(
        `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES ('akw_scope_ambiguous', ?, 'privy_wallet_a', '["wallets:read"]')`,
        [TEST_API_KEY.id]
      );
    });
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
        "/v1/wallets?view=summary",
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

    const requestPublicKey = (walletId: string) =>
      app.request(
        `/v1/wallets/public-key${walletId ? `?walletId=${walletId}` : ""}`,
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

    expect((await requestPublicKey("")).status).toBe(404);
    expect((await requestPublicKey("")).status).toBe(404);

    const explicit = await requestPublicKey("privy_wallet_b");
    expect(explicit.status).toBe(200);
    expect(await explicit.json()).toMatchObject({ data: { publicKey: SEEDED_PUBLIC_KEYS.privyB } });
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

    expect(required(updated).label).toBe("Operations");
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

    it("returns 404 when a wallet-scoped key deletes a wallet outside its bindings", async () => {
      await seedCachedKey({
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
      expect(required(wallet).status).toBe("active");
    });

    it("lets a bound wallet through the delete binding gate", async () => {
      await seedCachedKey({
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

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(/deletion not supported/i);
    });

    it("rejects wallet creation with a wallet-scoped key", async () => {
      await seedCachedKey({
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
  });
});
