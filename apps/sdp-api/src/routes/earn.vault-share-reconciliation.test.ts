import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { UpsertEarnStrategyInput } from "@/db/repositories/earn.repository";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const { getSplTokenBalances } = vi.hoisted(() => ({ getSplTokenBalances: vi.fn() }));
vi.mock("@/routes/payments/token-accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/routes/payments/token-accounts")>()),
  getSplTokenBalances,
}));

// The endpoint genesis-proof and per-cluster URL resolution are chain-facing;
// balances themselves come from the mocked read above, so no RPC request is
// ever issued by these tests.
const { assertClusterEndpoint, resolveClusterRpcUrl } = vi.hoisted(() => ({
  assertClusterEndpoint: vi.fn(async () => {}),
  resolveClusterRpcUrl: vi.fn(() => "http://127.0.0.1:8899"),
}));
vi.mock("@/services/earn/execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/execution-registry")>()),
  assertClusterEndpoint,
  resolveClusterRpcUrl,
}));

// Lets one test shrink the pass budget to prove the deadline posture; null
// keeps the handler's real default.
const { deadlineTimeoutOverride } = vi.hoisted(() => ({
  deadlineTimeoutOverride: { ms: null as number | null },
}));
vi.mock("@/services/earn/vault-deadline", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/services/earn/vault-deadline")>();
  return {
    ...original,
    createVaultDeadline: (timeoutMs?: number) =>
      original.createVaultDeadline(deadlineTimeoutOverride.ms ?? timeoutMs),
  };
});

const ORG = "org_share_reconciliation";
const USER = "usr_share_reconciliation";
const PROJECT_A = "prj_share_reconciliation_a";
const PROJECT_B = "prj_share_reconciliation_b";
const CONFIG_A = "cfg_share_reconciliation_a";
const CONFIG_A2 = "cfg_share_reconciliation_a2";
const CONFIG_B = "cfg_share_reconciliation_b";
const WALLET_A = "cwlt_share_reconciliation_a";
const WALLET_A2 = "cwlt_share_reconciliation_a2";
const WALLET_B = "cwlt_share_reconciliation_b";
const PROVIDER_WALLET_A = "privy_share_reconciliation_a";
const PROVIDER_WALLET_A2 = "privy_share_reconciliation_a2";
const PROVIDER_WALLET_B = "privy_share_reconciliation_b";
const PUBLIC_KEY_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const PUBLIC_KEY_A2 = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const PUBLIC_KEY_B = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT_CATALOGUED = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const SHARE_MINT_RECORDED = "So11111111111111111111111111111111111111112";
const SHARE_MINT_EMPTY = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const SHARE_MINT_MIRROR = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const API_KEY = { id: "key_share_reconciliation", raw: "sk_test_share_reconciliation" };

function cachedKey(): CachedApiKey {
  return {
    id: API_KEY.id,
    organizationId: ORG,
    projectId: PROJECT_A,
    role: "api_admin",
    permissions: ["*"],
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
  };
}

async function seedScope(): Promise<void> {
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, cachedKey());
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Share Reconciliation Org", "share-reconciliation", "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "share-reconciliation@example.com"),
    ...[PROJECT_A, PROJECT_B].map((projectId, index) =>
      getDb(env)
        .prepare(
          `INSERT INTO projects
             (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
        )
        .bind(projectId, ORG, `Project ${index}`, `share-reconciliation-${index}`, USER)
    ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'api_admin', '["*"]'::jsonb, 'active')`
      )
      .bind(API_KEY.id, ORG, PROJECT_A, USER, "Reconciliation key", "sk_test_sha", keyHash),
    ...[
      [CONFIG_A, PROJECT_A, WALLET_A, PROVIDER_WALLET_A, PUBLIC_KEY_A],
      [CONFIG_B, PROJECT_B, WALLET_B, PROVIDER_WALLET_B, PUBLIC_KEY_B],
    ].flatMap(([configId, projectId, walletId, providerWalletId, publicKey]) => [
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, status)
           VALUES (?, ?, ?, 'privy', 'encrypted', 'active')`
        )
        .bind(configId, ORG, projectId),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, status)
           VALUES (?, ?, ?, ?, 'active')`
        )
        .bind(walletId, configId, providerWalletId, publicKey),
    ]),
  ]);
}

/**
 * A second wallet PROJECT_A can see, through an ORGANIZATION-level config
 * (`project_id IS NULL` — a second project-level 'privy' config would violate
 * the (org, project, provider) unique). Same visibility either way:
 * `listWallets` hands org-level configs to every project.
 */
async function seedSecondProjectAWallet(): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, NULL, 'privy', 'encrypted', 'active')`
      )
      .bind(CONFIG_A2, ORG),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(WALLET_A2, CONFIG_A2, PROVIDER_WALLET_A2, PUBLIC_KEY_A2),
  ]);
}

async function seedStrategy(overrides: Partial<UpsertEarnStrategyInput> = {}) {
  const strategy = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
    provider: "kamino",
    providerReference: `vault-${crypto.randomUUID()}`,
    name: "Reconciliation USDC Vault",
    sourceKind: "defi",
    underlyingSource: "kamino",
    depositMints: [TOKEN_MINT],
    shareMint: SHARE_MINT_CATALOGUED,
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
  if (!strategy) {
    throw new Error("Failed to seed earn strategy");
  }
  return strategy;
}

async function createPosition(params: {
  projectId?: string;
  walletId?: string;
  providerReference?: string;
  shareMint?: string;
}) {
  const providerReference = params.providerReference ?? `vault_${crypto.randomUUID()}`;
  return createPostgresEarnMovementsRepository(getDb(env)).createSignedVaultDepositIntent({
    organizationId: ORG,
    projectId: params.projectId ?? PROJECT_A,
    environment: "sandbox",
    provider: "kamino",
    vaultAddress: providerReference,
    custodyWalletId: params.walletId ?? WALLET_A,
    sourceAddress: PUBLIC_KEY_A,
    tokenMint: TOKEN_MINT,
    shareMint: params.shareMint ?? SHARE_MINT_RECORDED,
    label: `Vault ${providerReference}`,
    requestedAmount: "1",
    signature: `sig_${crypto.randomUUID()}`,
    signedTransaction: "AQ==",
    lastValidBlockHeight: "12345",
    requestId: crypto.randomUUID(),
    idempotencyFingerprint: `fingerprint_${providerReference}`,
    createdBy: USER,
  });
}

async function finalizeMovement(movementId: string): Promise<void> {
  const now = new Date().toISOString();
  const advanced = await createPostgresEarnMovementsRepository(getDb(env)).advanceVaultMovement({
    movementId,
    organizationId: ORG,
    toStatus: "finalized",
    confirmedAt: now,
    settledAt: now,
  });
  if (!advanced) {
    throw new Error(`Failed to finalize movement ${movementId}`);
  }
}

function balance(mint: string, amount: string, decimals = 6) {
  return { token: "custom", mint, amount, uiAmount: amount, decimals };
}

function getReconciliation() {
  return app.request(
    "/v1/earn/vault-share-reconciliation",
    { headers: { Authorization: `Bearer ${API_KEY.raw}` } },
    env
  );
}

interface ReportBody {
  data: {
    unrecordedHoldings: Array<Record<string, unknown>>;
    unbackedPositions: Array<Record<string, unknown>>;
    unreadableWallets: Array<Record<string, unknown>>;
  };
}

beforeEach(async () => {
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  await seedTestDatabase(env);
  await clearKVStores(env);
  await seedScope();
  vi.clearAllMocks();
  deadlineTimeoutOverride.ms = null;
  assertClusterEndpoint.mockResolvedValue(undefined);
  resolveClusterRpcUrl.mockReturnValue("http://127.0.0.1:8899");
  getSplTokenBalances.mockResolvedValue([]);
});

describe("GET /v1/earn/vault-share-reconciliation", () => {
  it("surfaces a catalogued share balance that has no recorded claim behind it", async () => {
    const strategy = await seedStrategy();
    getSplTokenBalances.mockResolvedValue([balance(SHARE_MINT_CATALOGUED, "500")]);

    const response = await getReconciliation();
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReportBody;

    expect(body.data.unrecordedHoldings).toEqual([
      {
        custodyWalletId: WALLET_A,
        walletAddress: PUBLIC_KEY_A,
        provider: "kamino",
        strategyId: strategy.id,
        strategyName: strategy.name,
        vaultAddress: strategy.provider_reference,
        shareMint: SHARE_MINT_CATALOGUED,
        shares: "500",
        decimals: 6,
        uiShares: "500",
        ambiguousAttribution: false,
      },
    ]);
    expect(body.data.unbackedPositions).toEqual([]);
    expect(body.data.unreadableWallets).toEqual([]);
  });

  it("prefers the active catalogue row for a duplicated share mint and flags the ambiguity", async () => {
    const active = await seedStrategy({ providerReference: "vault-active" });
    await seedStrategy({ providerReference: "vault-superseded", status: "deprecated" });
    getSplTokenBalances.mockResolvedValue([balance(SHARE_MINT_CATALOGUED, "500")]);

    const response = await getReconciliation();
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReportBody;

    expect(body.data.unrecordedHoldings).toEqual([
      expect.objectContaining({
        strategyId: active.id,
        vaultAddress: "vault-active",
        ambiguousAttribution: true,
      }),
    ]);
  });

  it("reports wallets the request budget could not read instead of hanging or skipping them", async () => {
    const claim = await createPosition({ shareMint: SHARE_MINT_EMPTY });
    await finalizeMovement(claim.movement.id);
    deadlineTimeoutOverride.ms = 1;
    getSplTokenBalances.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 100))
    );

    const response = await getReconciliation();
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReportBody;

    expect(body.data.unreadableWallets).toEqual([
      { custodyWalletId: WALLET_A, walletAddress: PUBLIC_KEY_A },
    ]);
    expect(body.data.unbackedPositions).toEqual([]);
  });

  it("reports a settled claim whose wallet holds none of its shares, and not one that is backed", async () => {
    const backed = await createPosition({ shareMint: SHARE_MINT_RECORDED });
    await finalizeMovement(backed.movement.id);
    const empty = await createPosition({ shareMint: SHARE_MINT_EMPTY });
    await finalizeMovement(empty.movement.id);
    getSplTokenBalances.mockResolvedValue([balance(SHARE_MINT_RECORDED, "250")]);

    const response = await getReconciliation();
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReportBody;

    expect(body.data.unbackedPositions).toEqual([
      expect.objectContaining({
        positionId: empty.position.id,
        custodyWalletId: WALLET_A,
        shareMint: SHARE_MINT_EMPTY,
      }),
    ]);
    // The backed claim's balance is recorded, so it is not an unrecorded
    // holding — even without a catalogue row for its mint.
    expect(body.data.unrecordedHoldings).toEqual([]);
    expect(body.data.unreadableWallets).toEqual([]);
  });

  it("keeps a claim with an unsettled movement out of the zero-share report", async () => {
    await createPosition({ shareMint: SHARE_MINT_RECORDED });

    const response = await getReconciliation();
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReportBody;

    expect(body.data.unbackedPositions).toEqual([]);
    expect(body.data.unreadableWallets).toEqual([]);
  });

  it("never reads or reports a wallet outside the key's binding scope", async () => {
    await seedSecondProjectAWallet();
    await seedStrategy();
    getSplTokenBalances.mockResolvedValue([balance(SHARE_MINT_CATALOGUED, "500")]);
    const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
    await seedCachedApiKey(env, keyHash, {
      ...cachedKey(),
      signingWalletId: PROVIDER_WALLET_A,
      walletBindings: [{ walletId: PROVIDER_WALLET_A, permissions: ["earn:read"] }],
    });

    const response = await getReconciliation();
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReportBody;

    expect(getSplTokenBalances).toHaveBeenCalledTimes(1);
    expect(getSplTokenBalances.mock.calls[0]?.[1]).toBe(PUBLIC_KEY_A);
    expect(body.data.unrecordedHoldings).toEqual([
      expect.objectContaining({ custodyWalletId: WALLET_A, walletAddress: PUBLIC_KEY_A }),
    ]);
  });

  it("names an unreadable wallet, withdraws its zero-share findings, and touches no rows", async () => {
    const claim = await createPosition({ shareMint: SHARE_MINT_EMPTY });
    await finalizeMovement(claim.movement.id);
    getSplTokenBalances.mockRejectedValue(new Error("rpc unavailable"));

    const response = await getReconciliation();
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReportBody;

    expect(body.data.unreadableWallets).toEqual([
      { custodyWalletId: WALLET_A, walletAddress: PUBLIC_KEY_A },
    ]);
    expect(body.data.unbackedPositions).toEqual([]);
    expect(body.data.unrecordedHoldings).toEqual([]);

    const row = await createPostgresEarnMovementsRepository(getDb(env)).getPositionById({
      organizationId: ORG,
      environment: "sandbox",
      positionId: claim.position.id,
    });
    expect(row?.closed_at).toBeNull();
  });

  it("never attributes a balance through the browse-only mirror of the other cluster's shelf", async () => {
    await seedStrategy({ shareMint: SHARE_MINT_MIRROR, hostCluster: "mainnet-beta" });
    getSplTokenBalances.mockResolvedValue([balance(SHARE_MINT_MIRROR, "500")]);

    const response = await getReconciliation();
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReportBody;

    expect(body.data.unrecordedHoldings).toEqual([]);
    expect(body.data.unbackedPositions).toEqual([]);
    expect(body.data.unreadableWallets).toEqual([]);
  });
});
