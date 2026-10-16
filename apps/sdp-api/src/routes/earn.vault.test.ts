import assert from "node:assert/strict";
import type { CustodyProvider } from "@sdp/custody";
import { supportsVaultDepositQuote } from "@sdp/earn/capabilities";
import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { ONDO_DEPLOYMENTS } from "@sdp/types/ondo-programs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { required } from "@/test/helpers/required";

const surfacing = vi.hoisted(() => ({ forceOn: false }));

vi.mock("@sdp/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sdp/types")>();
  return {
    ...actual,
    isEarnProviderSurfaced: (provider: string) =>
      surfacing.forceOn || actual.isEarnProviderSurfaced(provider),
    isVaultDirectDepositEnabled: (environment: string, provider: string) =>
      surfacing.forceOn || actual.isVaultDirectDepositEnabled(environment, provider),
  };
});

import { getDb } from "@/db";
import {
  createPostgresEarnRepository,
  type EarnStrategyRow,
  type UpsertEarnStrategyInput,
} from "@/db/repositories";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import app from "@/index";
import { badRequest, serviceUnavailable } from "@/lib/errors";
import { buildEarnVaultDepositFingerprint } from "@/lib/idempotency";
import { AuditService } from "@/services/audit.service";
import { resolveEarnExecutionClient } from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import {
  seedTestPrivyConnection,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const depositIntoVault = vi.hoisted(() => vi.fn());

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

vi.mock("@/services/earn/vault-deposit.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/vault-deposit.service")>()),
  depositIntoVault,
}));

const vaultDirectClientOverride = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/services/earn/execution-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/earn/execution-registry")>();
  return {
    ...actual,
    resolveVaultDirectClient: (...args: Parameters<typeof actual.resolveVaultDirectClient>) =>
      (vaultDirectClientOverride.current as ReturnType<
        typeof actual.resolveVaultDirectClient
      > | null) ?? actual.resolveVaultDirectClient(...args),
  };
});

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
const PROD_CACHED_API_KEY: CachedApiKey = {
  ...TEST_CACHED_API_KEY,
  id: PROD_API_KEY.id,
  projectId: TEST_PRODUCTION_PROJECT.id,
  environment: "production",
};

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";

const USDY_MINT = required(ONDO_DEPLOYMENTS["mainnet-beta"]).usdyMint;
assert(!(USDY_MINT === ""));
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;
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

function recordConnectionDeposit(strategy: EarnStrategyRow, requestId: string) {
  return createPostgresEarnMovementsRepository(getDb(env)).createSignedVaultDepositIntent({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    environment: "sandbox",
    provider: strategy.provider,
    vaultAddress: strategy.provider_reference,
    custodyWalletId: "cwlt_earn_vault_connection",
    sourceAddress: WALLET_ADDRESS,
    tokenMint: USDC_MINT,
    shareMint: SHARE_MINT,
    label: strategy.name,
    requestedAmount: "10",
    signature: "sig_recorded_deposit",
    signedTransaction: "AQ==",
    lastValidBlockHeight: "12345",
    requestId,
    idempotencyFingerprint: buildEarnVaultDepositFingerprint({
      environment: "sandbox",
      provider: strategy.provider,
      providerReference: strategy.provider_reference,
      custodyWalletId: "cwlt_earn_vault_connection",
      amount: "10",
      minSharesOut: "1",
    }),
    createdBy: TEST_USER.id,
  });
}

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);
  const prodKeyHash = await hashString(PROD_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, prodKeyHash, PROD_CACHED_API_KEY);

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
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "Earn Vault Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        PROD_API_KEY.id,
        TEST_ORG.id,
        TEST_PRODUCTION_PROJECT.id,
        TEST_USER.id,
        "Earn Vault Production Key",
        PROD_API_KEY.prefix,
        prodKeyHash,
        "api_admin",
        JSON.stringify(["*"]),
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

function postVaultDeposit(
  body: Record<string, unknown>,
  idempotencyKey: string | undefined,
  apiKey: string
) {
  const request: Record<string, unknown> = { minSharesOut: "1", ...body };
  const key = idempotencyKey;
  delete request.requestId;
  return app.request(
    "/v1/earn/vault-deposits",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(key === undefined ? {} : { "Idempotency-Key": key }),
      },
      body: JSON.stringify(request),
    },
    env
  );
}

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
  originalJupiterSwapApiKey = env.JUPITER_SWAP_API_KEY;
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  custodyReleaseChannel.outOfChannelMode = null;
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.clearAllMocks();
  depositIntoVault.mockResolvedValue({
    position: { id: "earn_vault_position_test" },
    movement: {
      id: "earn_vault_movement_test",
      status: "submitted",
      signature: "sig_test",
      failure_reason: null,
    },
    replayed: false,
  });
});

afterEach(() => {
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
  env.JUPITER_SWAP_API_KEY = originalJupiterSwapApiKey;
  surfacing.forceOn = false;
  vaultDirectClientOverride.current = null;
  vi.restoreAllMocks();
});

describe("POST /v1/earn/vault-deposits — custody runtime admission", () => {
  it.each([
    { state: "retired-credential", status: 409, reason: "runtime_execution_unavailable" },
    { state: "inactive-wallet", status: 404, reason: undefined },
    { state: "provider-denied", status: 403, reason: "provider_not_entitled" },
  ])("refuses a new deposit with a $state wallet before recording anything", async (scenario) => {
    await seedAuth();
    await seedConnectionWallet();
    const strategy = await seedStrategy({});
    if (scenario.state === "retired-credential") {
      await getDb(env)
        .prepare("UPDATE provider_credentials SET status = 'retired' WHERE id = 'pcred_earn_vault'")
        .run();
    }
    if (scenario.state === "inactive-wallet") {
      await getDb(env)
        .prepare(
          "UPDATE custody_wallets SET status = 'inactive' WHERE id = 'cwlt_earn_vault_connection'"
        )
        .run();
    }
    if (scenario.state === "provider-denied") {
      await getDb(env)
        .prepare(
          "UPDATE organizations SET settings = jsonb_set(settings::jsonb, '{providerOverrides,custody}', ?::jsonb)::text WHERE id = ?"
        )
        .bind(JSON.stringify({ privy: false }), TEST_ORG.id)
        .run();
    }

    const response = await postVaultDeposit(
      { strategyId: strategy.id, custodyWalletId: "cwlt_earn_vault_connection", amount: "10" },
      `refused-${scenario.state}`,
      TEST_API_KEY.raw
    );

    expect(response.status).toBe(scenario.status);
    if (scenario.reason !== undefined) {
      expect(await response.json()).toMatchObject({
        error: { details: { reason: scenario.reason } },
      });
    }
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("refuses an unavailable wallet before opening an audit intent or deposit", async () => {
    await seedAuth();
    await seedConnectionWallet();
    const strategy = await seedStrategy({});
    await getDb(env)
      .prepare("UPDATE provider_credentials SET status = 'retired' WHERE id = 'pcred_earn_vault'")
      .run();
    const audit = vi.spyOn(AuditService.prototype, "beginCritical");

    const response = await postVaultDeposit(
      { strategyId: strategy.id, custodyWalletId: "cwlt_earn_vault_connection", amount: "10" },
      "unavailable-deposit",
      TEST_API_KEY.raw
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: "runtime_execution_unavailable" } },
    });
    expect(depositIntoVault).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("returns an ordinary recorded deposit while the BYOK pair is out of channel", async () => {
    await seedAuth();
    await seedConnectionWallet();
    const strategy = await seedStrategy({});
    const recorded = await recordConnectionDeposit(strategy, "recorded-deposit");
    custodyReleaseChannel.outOfChannelMode = "byok";

    const response = await postVaultDeposit(
      { strategyId: strategy.id, custodyWalletId: "cwlt_earn_vault_connection", amount: "10" },
      "recorded-deposit",
      TEST_API_KEY.raw
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { movementId: recorded.movement.id, replayed: true, signature: "sig_recorded_deposit" },
    });
    expect(depositIntoVault).not.toHaveBeenCalled();
  });
});

describe("POST /v1/earn/vault-deposits — catalogue admission", () => {
  it("opens Kamino from production and requires the caller's minSharesOut (PRO-1986)", async () => {
    await seedAuth();
    await seedProductionConnectionWallet({
      connectionId: "cconn_earn_vault_kamino_prod",
      credentialId: "pcred_earn_vault_kamino_prod",
      custodyWalletId: "cwlt_earn_vault_kamino_prod",
      providerWalletId: "privy_earn_vault_kamino_prod",
    });
    const strategy = await seedStrategy({ hostCluster: "mainnet-beta", environment: "production" });

    const missingFloor = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_kamino_prod",
        amount: "10",
        minSharesOut: undefined,
      },
      crypto.randomUUID(),
      PROD_API_KEY.raw
    );
    expect(missingFloor.status).toBe(400);
    const missingFloorBody = (await missingFloor.json()) as {
      error: { code: string; message: string };
    };
    expect(missingFloorBody.error.code).toBe("BAD_REQUEST");
    expect(missingFloorBody.error.message).toContain("POST /v1/earn/vault-deposit-previews");
    expect(depositIntoVault).not.toHaveBeenCalled();

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_kamino_prod",
        amount: "10",
        minSharesOut: "9.99",
      },
      crypto.randomUUID(),
      PROD_API_KEY.raw
    );
    expect(res.status).toBe(200);
    expect(depositIntoVault).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environment: "production",
        provider: "kamino",
        minSharesOut: "9.99",
      })
    );
  });

  it("keeps production closed for a provider the deposit-environment map leaves sandbox-only", async () => {
    await seedAuth();
    await seedProductionConnectionWallet({
      connectionId: "cconn_earn_vault_veda_prod",
      credentialId: "pcred_earn_vault_veda_prod",
      custodyWalletId: "cwlt_earn_vault_veda_prod",
      providerWalletId: "privy_earn_vault_veda_prod",
    });
    const strategy = await seedStrategy({
      provider: "veda",
      underlyingSource: "veda",
      hostCluster: "mainnet-beta",
      environment: "production",
    });
    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_veda_prod",
        amount: "10",
        minSharesOut: "9.99",
      },
      crypto.randomUUID(),
      PROD_API_KEY.raw
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("not available");
    expect(body.error.message).toContain("production");
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("opens Jupiter Lend only from production and requires the caller's minSharesOut", async () => {
    await seedAuth();
    await seedProductionConnectionWallet({
      connectionId: "cconn_earn_vault_jupiter",
      credentialId: "pcred_earn_vault_jupiter",
      custodyWalletId: "cwlt_earn_vault_jupiter",
      providerWalletId: "privy_earn_vault_jupiter",
    });
    const strategy = await seedStrategy({
      provider: "jupiter_lend",
      providerReference: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      name: "Jupiter Lend USDT",
      underlyingSource: "Jupiter Lend",
      depositMints: ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"],
      shareMint: "Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A",
      hostCluster: "mainnet-beta",
      environment: "production",
    });

    const missingFloor = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_jupiter",
        amount: "10",
        minSharesOut: undefined,
      },
      crypto.randomUUID(),
      PROD_API_KEY.raw
    );
    expect(missingFloor.status).toBe(400);
    expect(depositIntoVault).not.toHaveBeenCalled();

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_jupiter",
        amount: "10",
        minSharesOut: "9.99",
      },
      crypto.randomUUID(),
      PROD_API_KEY.raw
    );

    expect(res.status).toBe(200);
    expect(depositIntoVault).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environment: "production",
        provider: "jupiter_lend",
        minSharesOut: "9.99",
      })
    );
  });

  it("opens Ondo USDY only from production and requires the caller's minSharesOut", async () => {
    await seedAuth();
    await seedProductionConnectionWallet({
      connectionId: "cconn_earn_vault_ondo",
      credentialId: "pcred_earn_vault_ondo",
      custodyWalletId: "cwlt_earn_vault_ondo",
      providerWalletId: "privy_earn_vault_ondo",
    });
    const strategy = await seedStrategy({
      provider: "ondo",
      providerReference: USDY_MINT,
      name: "Ondo USDY",
      sourceKind: "rwa",
      underlyingSource: "ondo-usdy",
      depositMints: [USDC_MINT],
      shareMint: USDY_MINT,
      hostCluster: "mainnet-beta",
      environment: "production",
    });

    env.JUPITER_SWAP_API_KEY = undefined;
    const unconfigured = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_ondo",
        amount: "10",
        minSharesOut: "9.9",
      },
      crypto.randomUUID(),
      PROD_API_KEY.raw
    );
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({
      error: {
        code: "PROVIDER_NOT_CONFIGURED",
        message: "Ondo is not configured for production projects in this deployment.",
      },
    });
    expect(depositIntoVault).not.toHaveBeenCalled();

    env.JUPITER_SWAP_API_KEY = "jup_test_key";

    const missingFloor = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_ondo",
        amount: "10",
        minSharesOut: undefined,
      },
      crypto.randomUUID(),
      PROD_API_KEY.raw
    );
    expect(missingFloor.status).toBe(400);
    expect(depositIntoVault).not.toHaveBeenCalled();

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_ondo",
        amount: "10",
        minSharesOut: "9.9",
      },
      crypto.randomUUID(),
      PROD_API_KEY.raw
    );

    expect(res.status).toBe(200);
    expect(depositIntoVault).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environment: "production",
        provider: "ondo",
        minSharesOut: "9.9",
      })
    );
  });

  it("refuses a paused strategy", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ status: "paused" });

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: WALLET_ADDRESS,
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("paused");
  });

  it("refuses a deprecated strategy", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ status: "deprecated" });

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: WALLET_ADDRESS,
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(400);
  });

  it("refuses a strategy whose host cluster is not fundable here", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ hostCluster: "mainnet-beta" });

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: WALLET_ADDRESS,
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("mainnet-beta");
  });
});

describe("POST /v1/earn/vault-deposits — request validation", () => {
  it("requires an Idempotency-Key header, because the chain has no dedupe of its own", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: WALLET_ADDRESS,
        amount: "10",
      },
      undefined,
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(400);
  });

  it("rejects a strategy without a deposit mint before any wallet work", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ depositMints: [] });

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_unused",
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(500);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("rejects the retired body requestId source even when the canonical header is present", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});
    const res = await app.request(
      "/v1/earn/vault-deposits",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "vault-header-key",
        },
        body: JSON.stringify({
          strategyId: strategy.id,
          custodyWalletId: "cwlt_unused",
          amount: "10",
          requestId: crypto.randomUUID(),
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("rejects a non-positive amount", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: WALLET_ADDRESS,
        amount: "0",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(400);
  });

  it("rejects a zero minSharesOut without lossy numeric coercion", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_unused",
        amount: "10",
        minSharesOut: "000.0000",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(400);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("404s an unknown strategy rather than leaking whether the id exists elsewhere", async () => {
    await seedAuth();

    const res = await postVaultDeposit(
      {
        strategyId: "earn_strategy_does_not_exist",
        custodyWalletId: WALLET_ADDRESS,
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(404);
  });

  it("requires a custody row id and rejects a raw wallet address", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});
    await seedWallet({
      publicKey: WALLET_ADDRESS,
      projectId: TEST_PROJECT.id,
      configId: "cfg_earn_vault_raw_address",
      provider: "privy",
      custodyWalletId: "cwlt_earn_vault_raw_address",
      providerWalletId: "privy_earn_vault_raw_address",
    });

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: WALLET_ADDRESS,
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(404);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("selects the exact custody row when scoped configurations share an address", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});
    await seedWallet({
      publicKey: WALLET_ADDRESS,
      projectId: TEST_PROJECT.id,
      configId: "cfg_earn_vault_first",
      provider: "privy",
      custodyWalletId: "cwlt_earn_vault_first",
      providerWalletId: "privy_earn_vault_first",
    });
    await seedWallet({
      publicKey: WALLET_ADDRESS,
      configId: "cfg_earn_vault_second",
      provider: "para",
      custodyWalletId: "cwlt_earn_vault_second",
      providerWalletId: "privy_earn_vault_second",
      projectId: TEST_PROJECT.id,
    });

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_second",
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(200);
    expect(depositIntoVault).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        wallet: expect.objectContaining({
          id: "cwlt_earn_vault_second",
          walletId: "privy_earn_vault_second",
        }),
      })
    );
  });

  it("accepts a connection-backed custody wallet row", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});
    await seedConnectionWallet();

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_connection",
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(200);
    expect(depositIntoVault).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        wallet: expect.objectContaining({
          id: "cwlt_earn_vault_connection",
          custodyConnectionId: "cconn_earn_vault",
        }),
      })
    );
  });

  it("rejects a provider wallet id even when scoped configurations reuse it", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});
    await seedWallet({
      publicKey: WALLET_ADDRESS,
      projectId: TEST_PROJECT.id,
      configId: "cfg_earn_vault_duplicate_a",
      provider: "privy",
      custodyWalletId: "cwlt_earn_vault_duplicate_a",
      providerWalletId: "privy_earn_vault_duplicate",
    });
    await seedWallet({
      configId: "cfg_earn_vault_duplicate_b",
      provider: "para",
      custodyWalletId: "cwlt_earn_vault_duplicate_b",
      providerWalletId: "privy_earn_vault_duplicate",
      publicKey: "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF",
      projectId: TEST_PROJECT.id,
    });

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "privy_earn_vault_duplicate",
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(404);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("does not let a selected-wallet key cross an ambiguous provider wallet id", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});
    await seedWallet({
      publicKey: WALLET_ADDRESS,
      projectId: TEST_PROJECT.id,
      configId: "cfg_earn_vault_bound_project",
      provider: "privy",
      custodyWalletId: "cwlt_earn_vault_bound_project",
      providerWalletId: "privy_earn_vault_bound_duplicate",
    });
    await seedWallet({
      publicKey: WALLET_ADDRESS,
      configId: "cfg_earn_vault_bound_second",
      provider: "para",
      custodyWalletId: "cwlt_earn_vault_bound_second",
      providerWalletId: "privy_earn_vault_bound_duplicate",
      projectId: TEST_PROJECT.id,
    });
    const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
    await seedCachedApiKey(env, keyHash, {
      ...TEST_CACHED_API_KEY,
      signingWalletId: "privy_earn_vault_bound_duplicate",
      walletBindings: [
        {
          walletId: "privy_earn_vault_bound_duplicate",
          permissions: ["earn:write"],
        },
      ],
    });

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_bound_second",
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(403);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });
});

describe("POST /v1/earn/vault-deposits — Veda", () => {
  const VEDA_SHARE_MINT = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";

  async function seedVedaStrategy() {
    return seedStrategy({
      provider: "veda",
      name: "Veda USDC vault #7",
      underlyingSource: undefined,
      shareMint: VEDA_SHARE_MINT,
      currentApy: null,
      riskMetadata: { platformFeeBps: 25, performanceFeeBps: 1000 },
    });
  }

  it("is refused for a provider that is not currently offered (upshift)", async () => {
    await seedAuth();
    const strategy = await seedStrategy({
      provider: "upshift",
      name: "Upshift USDC vault",
      underlyingSource: undefined,
    });
    await seedWallet({
      publicKey: WALLET_ADDRESS,
      projectId: TEST_PROJECT.id,
      configId: "cfg_earn_vault_unsurfaced_gate",
      provider: "privy",
      custodyWalletId: "cwlt_earn_vault_unsurfaced_gate",
      providerWalletId: "privy_earn_vault_unsurfaced_gate",
    });

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_unsurfaced_gate",
        amount: "10",
        minSharesOut: "9.5",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(403);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("refuses a deposit into a deployed but un-surfaced provider as provider_not_offered", async () => {
    await seedAuth();
    const strategy = await seedStrategy({
      provider: "hastra",
      name: "Hastra PRIME",
      underlyingSource: undefined,
      hostCluster: "mainnet-beta",
      environment: "production",
    });

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_unsurfaced_hastra",
        amount: "10",
        minSharesOut: "9.9",
      },
      crypto.randomUUID(),
      PROD_API_KEY.raw
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Hastra / Figure is not currently offered.",
        details: { reason: "provider_not_offered" },
      },
      meta: { requestId: expect.any(String) },
    });
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("dispatches a surfaced Veda row with the catalogue's own asset identity", async () => {
    await seedAuth();
    const strategy = await seedVedaStrategy();
    await seedWallet({
      publicKey: WALLET_ADDRESS,
      projectId: TEST_PROJECT.id,
      configId: "cfg_earn_vault_veda",
      provider: "privy",
      custodyWalletId: "cwlt_earn_vault_veda",
      providerWalletId: "privy_earn_vault_veda",
    });
    const requestId = crypto.randomUUID();

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_veda",
        amount: "10",
        minSharesOut: "9.5",
        requestId,
      },
      requestId,
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(200);
    expect(depositIntoVault).toHaveBeenCalledTimes(1);
    expect(required(depositIntoVault.mock.calls[0])[1]).toMatchObject({
      provider: "veda",
      providerReference: strategy.provider_reference,

      tokenMint: USDC_MINT,
      shareMint: VEDA_SHARE_MINT,
      amount: "10",
      minSharesOut: "9.5",
      requestId,
    });
  });

  it("fails closed on a strategy naming a provider this deployment cannot execute", async () => {
    surfacing.forceOn = true;
    await seedAuth();
    const strategy = await seedVedaStrategy();
    await getDb(env)
      .prepare("UPDATE earn_strategies SET provider = 'vedanext' WHERE id = ?")
      .bind(strategy.id)
      .run();
    await seedWallet({
      publicKey: WALLET_ADDRESS,
      projectId: TEST_PROJECT.id,
      configId: "cfg_earn_vault_unknown",
      provider: "privy",
      custodyWalletId: "cwlt_earn_vault_unknown",
      providerWalletId: "privy_earn_vault_unknown",
    });

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_unknown",
        amount: "10",
        minSharesOut: "9.5",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(503);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });
});

describe("POST /v1/earn/vault-deposit-previews", () => {
  function postVaultDepositPreview(body: Record<string, unknown>, authenticated: boolean) {
    return app.request(
      "/v1/earn/vault-deposit-previews",
      {
        method: "POST",
        headers: {
          ...(authenticated ? { Authorization: `Bearer ${TEST_API_KEY.raw}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      env
    );
  }

  function quoteCapableClient(quote: unknown) {
    return {
      buildVaultDeposit: vi.fn(),
      readVaultPositions: vi.fn(),

      sponsoredPrograms: vi.fn(() => []),
      quoteVaultDeposit: vi.fn().mockResolvedValue(quote),
    };
  }

  it("quotes anonymously without resolving tenant entitlement", async () => {
    const strategy = await seedStrategy({ provider: "veda" });
    const client = quoteCapableClient({
      sharesOut: "9.99999",
      shareDecimals: 6,
      blockingIssues: [],
    });
    vaultDirectClientOverride.current = client;

    const res = await postVaultDepositPreview({ strategyId: strategy.id, amount: "10" }, false);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { strategyId: strategy.id, sharesOut: "9.99999" },
    });
  });

  it("refuses an anonymous quote for a deployed but un-surfaced provider", async () => {
    const strategy = await seedStrategy({
      provider: "hastra",
      name: "Hastra PRIME",
      underlyingSource: undefined,
      hostCluster: "mainnet-beta",
      environment: "production",
    });
    const client = quoteCapableClient({
      sharesOut: "9.99999",
      shareDecimals: 6,
      blockingIssues: [],
    });
    vaultDirectClientOverride.current = client;

    const res = await postVaultDepositPreview({ strategyId: strategy.id, amount: "10" }, false);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Hastra / Figure is not currently offered.",
        details: { reason: "provider_not_offered" },
      },
      meta: { requestId: expect.any(String) },
    });
    expect(client.quoteVaultDeposit).not.toHaveBeenCalled();
  });

  it("quotes anonymously on the shelf the strategy names, not the deployment's", async () => {
    const strategy = await seedStrategy({
      provider: "kamino",
      environment: "production",
      hostCluster: "mainnet-beta",
    });
    vaultDirectClientOverride.current = quoteCapableClient({
      sharesOut: "9.99999",
      shareDecimals: 6,
      blockingIssues: [],
    });

    const res = await postVaultDepositPreview({ strategyId: strategy.id, amount: "10" }, false);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { strategyId: strategy.id, sharesOut: "9.99999" },
    });
  });

  it("answers the provider's own quote for a surfaced, quotable strategy", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ provider: "veda" });
    const client = quoteCapableClient({
      sharesOut: "9.99999",
      shareDecimals: 6,
      blockingIssues: [{ code: "DEPOSIT_CAP_EXCEEDED", message: "Cap exceeded" }],
    });
    vaultDirectClientOverride.current = client;

    const res = await postVaultDepositPreview({ strategyId: strategy.id, amount: "10" }, true);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      strategyId: strategy.id,
      sharesOut: "9.99999",
      shareDecimals: 6,
      blockingIssues: [{ code: "DEPOSIT_CAP_EXCEEDED", message: "Cap exceeded" }],

      feeSponsored: false,
    });
    expect(client.quoteVaultDeposit).toHaveBeenCalledWith(expect.anything(), {
      providerReference: strategy.provider_reference,
      amount: "10",
    });
  });

  it("answers a sanitized retryable 503 when live provider state is unreadable", async () => {
    await seedAuth();
    const strategy = await seedStrategy({ provider: "veda" });
    const client = quoteCapableClient(undefined);
    client.quoteVaultDeposit.mockRejectedValue(
      Object.assign(new Error("RPC returned 429 from a secret endpoint"), {
        code: "VAULT_UNREADABLE",
      })
    );
    vaultDirectClientOverride.current = client;

    const res = await postVaultDepositPreview({ strategyId: strategy.id, amount: "10" }, true);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({
      code: "PROVIDER_UNAVAILABLE",
      message: "Earn provider is temporarily unavailable. Try again.",
    });
  });

  it("refuses an un-surfaced provider before quoting anything", async () => {
    await seedAuth();

    const strategy = await seedStrategy({ provider: "upshift" });
    const client = quoteCapableClient({ sharesOut: "1", shareDecimals: 6, blockingIssues: [] });
    vaultDirectClientOverride.current = client;

    const res = await postVaultDepositPreview({ strategyId: strategy.id, amount: "10" }, true);

    expect(res.status).toBe(403);
    expect(client.quoteVaultDeposit).not.toHaveBeenCalled();
  });

  it("answers 501 for a provider that cannot quote, measured against the real registry", async () => {
    surfacing.forceOn = true;
    const strategy = await seedStrategy({ provider: "upshift" });

    const res = await postVaultDepositPreview({ strategyId: strategy.id, amount: "10" }, false);

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("measures the real Kamino client as deposit-quote capable", () => {
    const client = resolveEarnExecutionClient(env, "kamino", createVaultDeadline());
    assert(client);
    expect(supportsVaultDepositQuote(client)).toBe(true);
  });

  it("answers 404 for a strategy this workspace cannot see", async () => {
    await seedAuth();

    const res = await postVaultDepositPreview(
      { strategyId: "earn_strategy_missing", amount: "1" },
      true
    );

    expect(res.status).toBe(404);
  });
});

describe("POST /v1/earn/vault-deposits: audit ledger parity (PRO-1866)", () => {
  it("records intent and outcome around the deposit, keyed to the movement", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});
    await seedWallet({
      publicKey: WALLET_ADDRESS,
      projectId: TEST_PROJECT.id,
      configId: "cfg_earn_vault_audit",
      provider: "privy",
      custodyWalletId: "cwlt_earn_vault_audit",
      providerWalletId: "privy_earn_vault_audit",
    });

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_audit",
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );
    expect(res.status).toBe(200);

    const { results } = await getDb(env)
      .prepare(
        "SELECT * FROM audit_logs WHERE action = 'deposit' AND resource_type = 'earn_movement'"
      )
      .all<Record<string, unknown>>();
    expect(results).toHaveLength(1);
    expect(required(results)[0]).toMatchObject({
      resource_id: "earn_vault_movement_test",
      organization_id: TEST_ORG.id,
      api_key_id: TEST_API_KEY.id,
      user_id: null,
    });

    const feed = await new AuditService(getDb(env)).getForOrganization(TEST_ORG.id, {
      action: "deposit",
    });
    expect(feed.some((entry) => entry.resourceId === "earn_vault_movement_test")).toBe(true);
  });

  it("refuses the deposit when the audit intent cannot persist: money-in fails closed", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});
    await seedWallet({
      publicKey: WALLET_ADDRESS,
      projectId: TEST_PROJECT.id,
      configId: "cfg_earn_vault_audit_down",
      provider: "privy",
      custodyWalletId: "cwlt_earn_vault_audit_down",
      providerWalletId: "privy_earn_vault_audit_down",
    });
    vi.spyOn(AuditService.prototype, "log").mockRejectedValue(new Error("audit ledger locked"));

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_audit_down",
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );

    expect(res.status).toBe(500);
    expect(depositIntoVault).not.toHaveBeenCalled();
  });

  it("closes the intent as a failure when the service refuses the deposit with a 4xx", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});
    await seedWallet({
      publicKey: WALLET_ADDRESS,
      projectId: TEST_PROJECT.id,
      configId: "cfg_earn_vault_audit_fail",
      provider: "privy",
      custodyWalletId: "cwlt_earn_vault_audit_fail",
      providerWalletId: "privy_earn_vault_audit_fail",
    });
    depositIntoVault.mockRejectedValue(badRequest("simulation failed"));

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_audit_fail",
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );
    expect(res.status).toBe(400);

    const { results } = await getDb(env)
      .prepare(
        "SELECT * FROM audit_logs WHERE action = 'deposit' AND resource_type = 'earn_movement'"
      )
      .all<Record<string, unknown>>();
    expect(results).toHaveLength(1);
    expect(required(results)[0]).toMatchObject({ status: "failure" });
    expect(String(required(required(results)[0]).metadata)).toContain("simulation failed");
  });

  it("leaves the intent unresolved on an ambiguous 5xx: the send may have landed", async () => {
    await seedAuth();
    const strategy = await seedStrategy({});
    await seedWallet({
      publicKey: WALLET_ADDRESS,
      projectId: TEST_PROJECT.id,
      configId: "cfg_earn_vault_audit_ambig",
      provider: "privy",
      custodyWalletId: "cwlt_earn_vault_audit_ambig",
      providerWalletId: "privy_earn_vault_audit_ambig",
    });
    depositIntoVault.mockRejectedValue(
      new Error("Vault deposit was broadcast but its ledger transition could not be verified")
    );

    const res = await postVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_audit_ambig",
        amount: "10",
        requestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      TEST_API_KEY.raw
    );
    expect(res.status).toBe(500);

    const { results } = await getDb(env)
      .prepare(
        "SELECT * FROM audit_logs WHERE action = 'deposit' AND resource_type = 'earn_movement'"
      )
      .all<Record<string, unknown>>();
    expect(results).toHaveLength(0);
  });
});

describe("vault deposit retry after a failed attempt", () => {
  async function setup() {
    await seedAuth();
    await seedConnectionWallet();
    const strategy = await seedStrategy({});
    return {
      strategy,
      body: {
        strategyId: strategy.id,
        custodyWalletId: "cwlt_earn_vault_connection",
        amount: "10",
      },
    };
  }

  it("runs the same key again after a failure that recorded nothing", async () => {
    const { body } = await setup();
    depositIntoVault.mockRejectedValueOnce(serviceUnavailable("RPC unavailable before signing"));
    expect(
      (await postVaultDeposit(body, "retry-after-build-failure", TEST_API_KEY.raw)).status
    ).toBe(503);
    expect(
      (await postVaultDeposit(body, "retry-after-build-failure", TEST_API_KEY.raw)).status
    ).toBe(200);
    expect(depositIntoVault).toHaveBeenCalledTimes(2);
  });

  it("replays the recorded movement after a durable intent even when execution threw", async () => {
    const { body, strategy } = await setup();
    depositIntoVault.mockImplementationOnce(async () => {
      await recordConnectionDeposit(strategy, "recorded-before-error");
      throw new Error("Broadcast outcome unknown");
    });
    expect((await postVaultDeposit(body, "recorded-before-error", TEST_API_KEY.raw)).status).toBe(
      500
    );
    expect((await postVaultDeposit(body, "recorded-before-error", TEST_API_KEY.raw)).status).toBe(
      200
    );
    expect(depositIntoVault).toHaveBeenCalledTimes(1);
  });
});
