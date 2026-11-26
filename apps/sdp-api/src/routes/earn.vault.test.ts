import assert from "node:assert/strict";
import { supportsVaultDepositQuote } from "@sdp/earn/capabilities";
import { hashString } from "@sdp/payments/hash";
import type { CustodyProvider } from "@sdp/types/custody";
import { ONDO_DEPLOYMENTS } from "@sdp/types/ondo-programs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import type { EarnStrategyRow, UpsertEarnStrategyInput } from "@/db/repositories/earn.repository";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import {
  createPostgresEarnWalletTransactionsRepository,
  generateEarnWalletTransactionId,
} from "@/db/repositories/earn-wallet-transactions.repository";
import { app } from "@/index";
import { serviceUnavailable } from "@/lib/errors";
import { resolveEarnExecutionClient } from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import type { WalletDepositBuildInput } from "@/services/earn/vault-wallet.service";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { recordCallScopes } from "@/test/helpers/cluster-scope";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import {
  seedTestPrivyConnection,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { type SeededApiKey, seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

const build = vi.hoisted(() => vi.fn());
// Admission fixtures are independent of the current address curation picks.
vi.mock("@/routes/earn/handlers/curation", async (original) => ({
  ...(await original<typeof import("@/routes/earn/handlers/curation")>()),
  CURATED_VAULTS: {},
  HIDDEN_VAULTS: {},
  HIDDEN_STRATEGY_TERMS: [],
}));
vi.mock("@sdp/types/release-channels", async (original) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(await original<typeof import("@sdp/types/release-channels")>());
});
vi.mock("@/services/earn/vault-wallet.service", async (original) => ({
  ...(await original<typeof import("@/services/earn/vault-wallet.service")>()),
  buildWalletDepositTransaction: build,
}));

const TEST_ORG = { id: "org_test_earn_vault", name: "Earn Vault Org", slug: "earn-vault" };
const TEST_PROJECT = { id: "prj_test_earn_vault", slug: "test-earn-vault-project" };
const TEST_PRODUCTION_PROJECT = {
  id: "prj_test_earn_vault_prod",
  slug: "test-earn-vault-project-prod",
};
const TEST_USER = { id: "usr_test_earn_vault", email: "earn-vault@example.com" };
const TEST_API_KEY = {
  id: "key_earn_vault",
  raw: "sk_test_earn_vault",
  prefix: "sk_test_ear",
};
const PROD_API_KEY = {
  id: "key_earn_vault_prod",
  raw: "sk_live_earn_vault",
  prefix: "sk_live_ear",
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
const PROD_CACHED_API_KEY: SeededApiKey = {
  ...TEST_SEEDED_API_KEY,
  id: PROD_API_KEY.id,
  projectId: TEST_PRODUCTION_PROJECT.id,
  environment: "production",
};

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";

const USDY_MINT = required(ONDO_DEPLOYMENTS["mainnet-beta"]).usdyMint;
assert(!(USDY_MINT === ""));
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

let originalEncryptionKey: string | undefined;
let originalJupiterSwapApiKey: string | undefined;

async function seedWallet(params: {
  configId: string;
  provider: CustodyProvider;
  custodyWalletId: string;
  providerWalletId: string;
  publicKey: string;
  projectId: string;
}): Promise<void> {
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: params.configId,
        organizationId: TEST_ORG.id,
        projectId: params.projectId,
        provider: params.provider,
        configEncrypted: "encrypted",
        status: "active",
      },
    ],
    wallets: [
      {
        id: params.custodyWalletId,
        owner: { kind: "config", custodyConfigId: params.configId },
        walletId: params.providerWalletId,
        publicKey: params.publicKey,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
  });
}

async function seedProductionConnectionWallet(params: {
  connectionId: string;
  credentialId: string;
  custodyWalletId: string;
  providerWalletId: string;
}): Promise<void> {
  env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 43).toString("base64");
  await seedTestPrivyConnection(getDb(env), {
    organizationId: TEST_ORG.id,
    projectId: TEST_PRODUCTION_PROJECT.id,
    connectionId: params.connectionId,
    credentialId: params.credentialId,
    createdBy: TEST_USER.id,
    stored: await writeTestPrivyCredentialSecret(env, {
      organizationId: TEST_ORG.id,
      credentialId: params.credentialId,
      appId: `${params.connectionId}-app`,
      appSecret: `${params.connectionId}-secret`,
    }),
    providerAccountFingerprint: `sha256:${params.connectionId}`,
    lastCheckStatus: "success",
    wallets: [
      {
        id: params.custodyWalletId,
        walletId: params.providerWalletId,
        publicKey: WALLET_ADDRESS,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
    defaultCustodyWalletId: params.custodyWalletId,
  });
}

async function seedConnectionWallet(): Promise<void> {
  env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 43).toString("base64");
  await seedTestPrivyConnection(getDb(env), {
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    connectionId: "cconn_earn_vault",
    credentialId: "pcred_earn_vault",
    createdBy: TEST_USER.id,
    stored: await writeTestPrivyCredentialSecret(env, {
      organizationId: TEST_ORG.id,
      credentialId: "pcred_earn_vault",
      appId: "earn-vault-connection-app",
      appSecret: "earn-vault-connection-secret",
    }),
    providerAccountFingerprint: "sha256:test",
    lastCheckStatus: "success",
    wallets: [
      {
        id: "cwlt_earn_vault_connection",
        walletId: "privy_earn_vault_connection",
        publicKey: WALLET_ADDRESS,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
    defaultCustodyWalletId: "cwlt_earn_vault_connection",
  });
}

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, keyHash, TEST_SEEDED_API_KEY);
  const prodKeyHash = await hashString(PROD_API_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, prodKeyHash, PROD_CACHED_API_KEY);

  await getDb(env).batch([
    getDb(env)
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status, settings) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(
        TEST_ORG.id,
        TEST_ORG.name,
        TEST_ORG.slug,
        "enterprise",
        "active",
        JSON.stringify({
          providerOverrides: {
            earn: { kamino: true, veda: true, jupiter_lend: true, ondo: true },
          },
        })
      ),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
  });
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "Earn Vault Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        ALL_API_KEY_GRANTS,
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        PROD_API_KEY.id,
        TEST_ORG.id,
        TEST_PRODUCTION_PROJECT.id,
        TEST_USER.id,
        "Earn Vault Production Key",
        PROD_API_KEY.prefix,
        prodKeyHash,
        ALL_API_KEY_GRANTS,
        "active"
      ),
  ]);
}

async function seedStrategy(overrides: Partial<UpsertEarnStrategyInput>): Promise<EarnStrategyRow> {
  const strategy = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
    provider: "kamino",
    providerReference: `vault-${crypto.randomUUID()}`,
    name: "Test USDC Vault",
    sourceKind: "defi",
    underlyingSource: "kamino",
    depositMints: [USDC_MINT],
    shareMint: SHARE_MINT,
    apyType: "variable",
    currentApy: "0.062",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    riskMetadata: {},
    status: "active",
    hostCluster: "devnet",
    environment: "sandbox",
    ...overrides,
  });
  assert(strategy);
  return strategy;
}

function post(
  path: string,
  body: unknown,
  key: string | undefined = crypto.randomUUID(),
  apiKey = TEST_API_KEY.raw
) {
  return app.request(
    `/v1/earn/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(key === undefined ? {} : { "Idempotency-Key": key }),
      },
      body: JSON.stringify(body),
    },
    env
  );
}

function deposit(
  strategyId: string,
  walletId = "cwlt_earn_vault_connection",
  overrides: Record<string, unknown> = {}
) {
  return {
    strategyId,
    source: { walletId },
    amount: { mint: USDC_MINT, value: "10" },
    ...overrides,
  };
}

beforeEach(async () => {
  originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
  originalJupiterSwapApiKey = env.JUPITER_SWAP_API_KEY;
  custodyReleaseChannel.outOfChannelMode = null;
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.resetAllMocks();
  build.mockImplementation(async (binding: Env, input: WalletDepositBuildInput) => ({
    kind: "built",
    built: await createPostgresEarnWalletTransactionsRepository(getDb(binding)).create({
      id: generateEarnWalletTransactionId(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: input.projectId === TEST_PRODUCTION_PROJECT.id ? "production" : "sandbox",
      provider: input.provider,
      strategyId: input.strategyId,
      custodyWalletId: input.custodyWalletId,
      direction: "deposit",
      ownerAddress: input.ownerAddress,
      vaultAddress: input.providerReference,
      tokenMint: input.tokenMint,
      shareMint: input.shareMint,
      label: input.label,
      denomination: input.tokenMint,
      amountRequested: input.amount,
      minSharesOut: "9.9",
      createsShareAccount: false,
      unsignedTransaction: "AQ==",
      lastValidBlockHeight: "100",
      createdBy: input.userId,
      initiatedByKeyId: input.apiKeyId,
    }),
    quote: { sharesOut: "10", shareDecimals: 6, blockingIssues: [] },
  }));
});

afterEach(() => {
  env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
  env.JUPITER_SWAP_API_KEY = originalJupiterSwapApiKey;
  vi.restoreAllMocks();
});

describe("POST /v1/earn/deposit custody preparation admission", () => {
  it.each([
    { state: "retired-credential", status: 400, reason: undefined },
    { state: "inactive-wallet", status: 404, reason: undefined },
    { state: "provider-denied", status: 400, reason: undefined },
  ])("refuses a $state wallet before building", async (scenario) => {
    await seedAuth();
    await seedConnectionWallet();
    const strategy = await seedStrategy({});
    if (scenario.state === "retired-credential")
      await getDb(env).execute(
        "UPDATE provider_credentials SET status = 'retired' WHERE id = 'pcred_earn_vault'"
      );
    if (scenario.state === "inactive-wallet")
      await getDb(env).execute(
        "UPDATE custody_wallets SET status = 'inactive' WHERE id = 'cwlt_earn_vault_connection'"
      );
    if (scenario.state === "provider-denied")
      await getDb(env).execute(
        "UPDATE organizations SET settings = jsonb_set(settings::jsonb, '{providerOverrides,custody}', ?::jsonb)::text WHERE id = ?",
        [JSON.stringify({ privy: false }), TEST_ORG.id]
      );
    const res = await post("deposit", deposit(strategy.id));
    expect(res.status, await res.clone().text()).toBe(scenario.status);
    if (scenario.reason)
      expect(await res.json()).toMatchObject({ error: { details: { reason: scenario.reason } } });
    expect(build).not.toHaveBeenCalled();
  });

  it("rejects a wallet outside the authenticated key's scope", async () => {
    await seedAuth();
    await seedConnectionWallet();
    const strategy = await seedStrategy({});
    await seedApiKeyRow(env, await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER), {
      ...TEST_SEEDED_API_KEY,
      walletScope: "selected",
      walletIds: [],
    });
    const res = await post("deposit", deposit(strategy.id));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { details: { reason: "wallet_out_of_scope" } },
    });
    expect(build).not.toHaveBeenCalled();
  });

  it.each(["paused", "deprecated"] as const)(
    "refuses a %s strategy before building",
    async (status) => {
      await seedAuth();
      await seedConnectionWallet();
      const strategy = await seedStrategy({ status });
      const res = await post("deposit", deposit(strategy.id));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(status);
      expect(build).not.toHaveBeenCalled();
    }
  );

  it("refuses a strategy hosted on another cluster", async () => {
    await seedAuth();
    await seedConnectionWallet();
    const strategy = await seedStrategy({ hostCluster: "mainnet-beta" });
    const res = await post("deposit", deposit(strategy.id));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("mainnet-beta");
    expect(build).not.toHaveBeenCalled();
  });

  it("keeps mainnet-only providers closed to a sandbox source", async () => {
    await seedAuth();
    await seedConnectionWallet();
    const strategy = await seedStrategy({ provider: "jupiter_lend" });
    const res = await post("deposit", deposit(strategy.id));
    expect(res.status).toBe(403);
    expect(build).not.toHaveBeenCalled();
  });

  it("refuses an unavailable provider configuration before building", async () => {
    await seedAuth();
    await seedProductionConnectionWallet({
      connectionId: "cconn_ondo",
      credentialId: "pcred_ondo",
      custodyWalletId: "cwlt_ondo",
      providerWalletId: "wallet_ondo",
    });
    const strategy = await seedStrategy({
      provider: "ondo",
      providerReference: USDY_MINT,
      hostCluster: "mainnet-beta",
      environment: "production",
    });
    env.JUPITER_SWAP_API_KEY = undefined;
    const res = await post(
      "deposit",
      deposit(strategy.id, "cwlt_ondo"),
      crypto.randomUUID(),
      PROD_API_KEY.raw
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "PROVIDER_NOT_CONFIGURED" } });
    expect(build).not.toHaveBeenCalled();
  });

  it.each(["kamino", "jupiter_lend", "ondo"] as const)(
    "prepares %s from production with server-derived review terms",
    async (provider) => {
      await seedAuth();
      await seedProductionConnectionWallet({
        connectionId: "cconn_production",
        credentialId: "pcred_production",
        custodyWalletId: "cwlt_production",
        providerWalletId: "provider_production",
      });
      env.JUPITER_SWAP_API_KEY = "jup_test_key";
      const strategy = await seedStrategy({
        provider,
        providerReference:
          provider === "ondo" ? USDY_MINT : "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
        hostCluster: "mainnet-beta",
        environment: "production",
      });
      const scopes = recordCallScopes(build);
      const res = await post(
        "deposit",
        deposit(strategy.id, "cwlt_production"),
        crypto.randomUUID(),
        PROD_API_KEY.raw
      );
      expect(res.status, await res.clone().text()).toBe(202);
      expect(await res.json()).toMatchObject({
        data: {
          operation: {
            status: "prepared",
            nextAction: { type: "submit" },
            terms: {
              estimate: { mint: SHARE_MINT, value: "10" },
              minimum: { mint: SHARE_MINT, value: "9.9" },
            },
          },
        },
      });
      expect(build).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          provider,
          strategyId: strategy.id,
          custodyWalletId: "cwlt_production",
          amount: "10",
          slippageBps: expect.any(Number),
        })
      );
      expect(scopes).toEqual([expect.objectContaining({ environment: "production" })]);
    }
  );

  it("uses the exact custody row when two wallets share one address", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});
    for (const suffix of ["first", "second"])
      await seedWallet({
        publicKey: WALLET_ADDRESS,
        projectId: TEST_PROJECT.id,
        configId: `cfg_${suffix}`,
        provider: suffix === "first" ? "privy" : "para",
        custodyWalletId: `cwlt_${suffix}`,
        providerWalletId: `provider_${suffix}`,
      });
    const res = await post("deposit", deposit(strategy.id, "cwlt_second"));
    expect(res.status, await res.clone().text()).toBe(202);
    expect(build).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ custodyWalletId: "cwlt_second", ownerAddress: WALLET_ADDRESS })
    );
  });

  it("replays a prepared operation after its strategy and custody runtime are disabled", async () => {
    await seedAuth();
    await seedConnectionWallet();
    const strategy = await seedStrategy({});
    const body = deposit(strategy.id);
    const first = await post("deposit", body, "prepared-before-pause");
    expect(first.status, await first.clone().text()).toBe(202);
    const firstBody = await first.json();
    await getDb(env).execute("UPDATE earn_strategies SET status = 'paused' WHERE id = ?", [
      strategy.id,
    ]);
    await getDb(env).execute(
      "UPDATE provider_credentials SET status = 'retired' WHERE id = 'pcred_earn_vault'"
    );
    const replay = await post("deposit", body, "prepared-before-pause");
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ data: firstBody.data });
    expect(build).toHaveBeenCalledTimes(1);
    const fresh = await post("deposit", body);
    expect(fresh.status).toBe(400);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("allows a same-key retry after a provider build failed before preparation was recorded", async () => {
    await seedAuth();
    await seedConnectionWallet();
    const strategy = await seedStrategy({});
    build.mockRejectedValueOnce(serviceUnavailable("RPC unavailable before building"));
    const body = deposit(strategy.id);
    expect((await post("deposit", body, "retry-build")).status).toBe(503);
    expect((await post("deposit", body, "retry-build")).status).toBe(202);
    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe("POST /v1/earn/deposit request identity", () => {
  it.each(["raw-address", "provider-wallet-id"])(
    "rejects %s as a custody source id",
    async (kind) => {
      await seedAuth();
      await seedConnectionWallet();
      const strategy = await seedStrategy({});
      const walletId = kind === "raw-address" ? WALLET_ADDRESS : "privy_earn_vault_connection";
      expect((await post("deposit", deposit(strategy.id, walletId))).status).toBe(404);
      expect(build).not.toHaveBeenCalled();
    }
  );

  it.each([
    { name: "zero amount", extra: { amount: { mint: USDC_MINT, value: "0" } } },
    {
      name: "ambiguous source",
      extra: { source: { walletId: "cwlt_earn_vault_connection", ownerAddress: WALLET_ADDRESS } },
    },
    { name: "retired requestId", extra: { requestId: "old-body-key" } },
    { name: "caller-supplied floor", extra: { minSharesOut: "1" } },
    { name: "excessive slippage", extra: { slippageBps: 10001 } },
  ])("rejects $name before building", async ({ extra }) => {
    await seedAuth();
    await seedConnectionWallet();
    const strategy = await seedStrategy({});
    expect((await post("deposit", deposit(strategy.id, undefined, extra))).status).toBe(400);
    expect(build).not.toHaveBeenCalled();
  });

  it("requires the canonical idempotency header", async () => {
    await seedAuth();
    await seedConnectionWallet();
    const strategy = await seedStrategy({});
    const res = await app.request(
      "/v1/earn/deposit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(deposit(strategy.id)),
      },
      env
    );
    expect(res.status).toBe(400);
    expect(build).not.toHaveBeenCalled();
  });

  it("refuses an unknown strategy without reaching its builder", async () => {
    await seedAuth();
    await seedConnectionWallet();
    expect((await post("deposit", deposit("earn_strategy_missing"))).status).toBe(404);
    expect(build).not.toHaveBeenCalled();
  });
});

describe("retired synchronous money-in routes", () => {
  it("retains the actual Kamino quote capability used by core preparation", () => {
    const client = required(resolveEarnExecutionClient(env, "kamino", createVaultDeadline()));
    expect(supportsVaultDepositQuote(client)).toBe(true);
  });
});
