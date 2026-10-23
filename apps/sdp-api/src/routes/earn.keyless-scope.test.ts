import { type ClusterScope, currentClusterScope } from "@sdp/rpc/scope";
import { actionsInModule } from "@sdp/types/actions";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { getDb } from "@/db/client";
import type { EarnStrategyRow, UpsertEarnStrategyInput } from "@/db/repositories/earn.repository";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import { generateEarnPositionId } from "@/db/repositories/earn-movements.repository";
import { app } from "@/index";
import { earnRoutes } from "@/routes/earn";
import { anonymousExitNeedsStrategy } from "@/routes/earn/handlers/external-wallet";
import {
  openKeylessCatalogueScope,
  openKeylessStrategyBodyScope,
  openKeylessStrategyParamScope,
} from "@/routes/earn/keyless-scope";
import {
  type EarnAuthzTenant,
  type EarnTestApiKey,
  seedEarnApiKey,
  seedEarnAuthzTenant,
} from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const buildExternalWalletDepositTransaction = vi.hoisted(() => vi.fn());
const buildExternalWalletWithdrawalTransaction = vi.hoisted(() => vi.fn());
// One vault-direct client stands in for every provider capability these routes
// reach, so each route's chain call can report the scope it ran in.
const providerClient = vi.hoisted(() => ({
  buildVaultDeposit: vi.fn(),
  buildVaultWithdrawal: vi.fn(),
  readVaultPositions: vi.fn(),
  sponsoredPrograms: vi.fn(() => []),
  quoteVaultDeposit: vi.fn(),
  quoteVaultWithdrawal: vi.fn(),
  getWithdrawalOptions: vi.fn(),
  quoteQueuedWithdrawal: vi.fn(),
}));

vi.mock("@/services/earn/vault-external-wallet.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/vault-external-wallet.service")>()),
  buildExternalWalletDepositTransaction,
  buildExternalWalletWithdrawalTransaction,
}));

vi.mock("@/services/earn/execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/execution-registry")>()),
  resolveVaultDirectClient: () => providerClient,
  resolveVaultWithdrawClient: () => providerClient,
  resolveVaultQueuedWithdrawClient: () => providerClient,
  resolveVaultParRedemptionClient: () => null,
}));

/**
 * Keyless Earn routes open the cluster scope (ADR 0007) from the shelf they
 * name: the strategy row's environment, or the list's `?environment=`. Keyed
 * routes keep their project's scope. Each stubbed provider or service call
 * below reads the scope it runs in, the way chain clients do once Earn reads
 * through `createClusterRpc()`.
 */

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const QUEUE_TERMS = { shares: "10", discountBps: 50, deadlineSeconds: 3_600 } as const;

interface KeylessPostRoute {
  /** A body naming a catalogue strategy: what a keyless caller sends. */
  strategyBody: (strategyId: string) => Record<string, unknown>;
  /** The provider or service call the route makes once its gates pass. */
  reached: () => Mock;
}

interface KeylessExitRoute extends KeylessPostRoute {
  /** A body naming a tenant position: what a keyed exit sends. */
  positionBody: (positionId: string) => Record<string, unknown>;
}

/** The money-in quote and build: a keyed caller names the strategy too. */
const MONEY_IN_ROUTES: Record<string, KeylessPostRoute> = {
  "/vault-deposit-previews": {
    strategyBody: (strategyId) => ({ strategyId, amount: "10" }),
    reached: () => providerClient.quoteVaultDeposit,
  },
  "/external-wallet/deposit-transactions": {
    strategyBody: (strategyId) => ({
      strategyId,
      ownerAddress: OWNER,
      amount: "25",
      minSharesOut: "1",
    }),
    reached: () => buildExternalWalletDepositTransaction,
  },
};

const EXIT_ROUTES: Record<string, KeylessExitRoute> = {
  "/external-wallet/withdrawal-previews": {
    strategyBody: (strategyId) => ({ strategyId, ownerAddress: OWNER, shares: "10" }),
    positionBody: (positionId) => ({ positionId, shares: "10" }),
    reached: () => providerClient.quoteVaultWithdrawal,
  },
  "/external-wallet/withdrawal-transactions": {
    strategyBody: (strategyId) => ({ strategyId, ownerAddress: OWNER, shares: "10" }),
    positionBody: (positionId) => ({ positionId, shares: "10" }),
    reached: () => buildExternalWalletWithdrawalTransaction,
  },
  "/external-wallet/withdrawal-options": {
    strategyBody: (strategyId) => ({ strategyId, ownerAddress: OWNER }),
    positionBody: (positionId) => ({ positionId }),
    reached: () => providerClient.getWithdrawalOptions,
  },
  "/external-wallet/queued-withdrawal-previews": {
    strategyBody: (strategyId) => ({ strategyId, ownerAddress: OWNER, ...QUEUE_TERMS }),
    positionBody: (positionId) => ({ positionId, ...QUEUE_TERMS }),
    reached: () => providerClient.quoteQueuedWithdrawal,
  },
};

const KEYLESS_POST_ROUTES: Record<string, KeylessPostRoute> = {
  ...MONEY_IN_ROUTES,
  ...EXIT_ROUTES,
};

const SHELVES = [
  { environment: "sandbox", cluster: "devnet" },
  { environment: "production", cluster: "mainnet-beta" },
] as const;

const observedScopes: ClusterScope[] = [];

let tenant: EarnAuthzTenant;
let key: EarnTestApiKey;
let ipCounter = 0;
let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;

function uniqueClientIp(): string {
  ipCounter += 1;
  return `10.1.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

function postEarn(path: string, body: Record<string, unknown>, apiKey: string | null) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "x-forwarded-for": uniqueClientIp(),
  });
  if (apiKey !== null) headers.set("Authorization", `Bearer ${apiKey}`);
  return app.request(
    `/v1/earn${path}`,
    { method: "POST", headers, body: JSON.stringify(body) },
    env
  );
}

async function seedStrategy(
  overrides: Partial<UpsertEarnStrategyInput> = {}
): Promise<EarnStrategyRow> {
  const strategy = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
    provider: "kamino",
    providerReference: `vault-${crypto.randomUUID()}`,
    name: "Scope USDC Vault",
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
  if (!strategy) throw new Error("Failed to seed earn strategy");
  return strategy;
}

async function seedExternalWalletPosition(project: {
  id: string;
  environment: SdpEnvironment;
}): Promise<string> {
  const id = generateEarnPositionId();
  await getDb(env)
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         owner_address, vault_address, share_mint, token_mint, label, activated_at
       ) VALUES (?, ?, ?, ?, 'kamino', 'vault_direct', ?, ?, ?, ?, 'Scope Vault', sdp_iso_now())`
    )
    .bind(id, tenant.org.id, project.id, project.environment, OWNER, VAULT, SHARE_MINT, USDC_MINT)
    .run();
  return id;
}

function builtRow(direction: "deposit" | "withdrawal") {
  const now = new Date().toISOString();
  return {
    id: `earn_external_wallet_transaction_${crypto.randomUUID()}`,
    organization_id: null,
    project_id: null,
    environment: "sandbox",
    provider: "kamino",
    direction,
    owner_address: OWNER,
    vault_address: VAULT,
    token_mint: USDC_MINT,
    share_mint: SHARE_MINT,
    label: "Scope USDC Vault",
    position_id: null,
    denomination: direction === "deposit" ? USDC_MINT : SHARE_MINT,
    amount_requested: direction === "deposit" ? "25" : "10",
    min_shares_out: null,
    creates_share_account: true,
    fee_payer: null,
    share_ata_rent_funder: null,
    unsigned_transaction: "AQ==",
    last_valid_block_height: "361",
    movement_id: null,
    consumed_at: null,
    created_by: null,
    initiated_by_key_id: null,
    created_at: now,
    updated_at: now,
  };
}

/** Records the open scope, then answers like the stubbed call. */
function inScope<T>(answer: T): () => Promise<T> {
  return async () => {
    observedScopes.push(currentClusterScope());
    return answer;
  };
}

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.clearAllMocks();
  observedScopes.length = 0;

  tenant = await seedEarnAuthzTenant(env, "keyless_scope", { environment: "sandbox" });
  key = await seedEarnApiKey(env, tenant, {
    id: "key_keyless_scope",
    grants: actionsInModule("earn"),
    environment: "sandbox",
  });
  // A keyed deposit takes the organization's provider entitlement.
  await getDb(env)
    .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
    .bind(JSON.stringify({ providerOverrides: { earn: { kamino: true } } }), tenant.org.id)
    .run();

  buildExternalWalletDepositTransaction.mockImplementation(
    inScope({ kind: "built", built: builtRow("deposit") })
  );
  buildExternalWalletWithdrawalTransaction.mockImplementation(inScope(builtRow("withdrawal")));
  providerClient.quoteVaultDeposit.mockImplementation(
    inScope({ sharesOut: "9.99", shareDecimals: 6, blockingIssues: [] })
  );
  providerClient.quoteVaultWithdrawal.mockImplementation(
    inScope({ assetsOut: "9.95", assetDecimals: 6, blockingIssues: [] })
  );
  providerClient.getWithdrawalOptions.mockImplementation(
    inScope({
      instant: true,
      queued: true,
      withdrawAuthority: null,
      queueState: null,
      queueAsset: null,
    })
  );
  providerClient.quoteQueuedWithdrawal.mockImplementation(
    inScope({ mechanism: "solverQueue", assetsOut: "9.9", assetDecimals: 6 })
  );
});

afterEach(() => {
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
});

describe("keyless Earn route wiring", () => {
  it("opens a scope on every keyless route, directly before its handler, and on no keyed route", () => {
    const openers: ReadonlySet<unknown> = new Set([
      openKeylessCatalogueScope,
      openKeylessStrategyParamScope,
      openKeylessStrategyBodyScope,
    ]);
    const chains = new Map<string, unknown[]>();
    for (const route of earnRoutes.routes) {
      if (route.method === "ALL") continue;
      const routeKey = `${route.method} ${route.path}`;
      chains.set(routeKey, [...(chains.get(routeKey) ?? []), route.handler]);
    }

    const keyless: string[] = [];
    for (const [routeKey, steps] of chains) {
      const openerSteps = steps.filter((step) => openers.has(step));
      const isKeyless = steps.some(
        (step) => typeof step === "function" && step.name === "optionalEarnAuth"
      );
      if (!isKeyless) {
        expect(openerSteps, routeKey).toEqual([]);
        continue;
      }
      keyless.push(routeKey);
      expect(openerSteps, routeKey).toHaveLength(1);
      expect(steps.at(-2), routeKey).toBe(openerSteps[0]);
    }
    expect(keyless.sort()).toEqual(
      [
        "GET /strategies",
        "GET /strategies/:strategyId",
        ...Object.keys(KEYLESS_POST_ROUTES).map((path) => `POST ${path}`),
      ].sort()
    );
  });
});

describe("keyless Earn routes run in the scope of the shelf they name", () => {
  it.each(Object.entries(KEYLESS_POST_ROUTES))(
    "%s runs anonymously in the scope of the named strategy's environment",
    async (path, route) => {
      for (const { environment, cluster } of SHELVES) {
        observedScopes.length = 0;
        const strategy = await seedStrategy({ environment, hostCluster: cluster });

        const res = await postEarn(path, route.strategyBody(strategy.id), null);

        expect(res.status, `${path} on ${environment}`).toBe(200);
        expect(observedScopes).toEqual([{ projectId: null, environment, cluster }]);
      }
    }
  );

  it.each(Object.entries(KEYLESS_POST_ROUTES))(
    "%s 404s an anonymous request naming an unknown strategy before any chain call",
    async (path, route) => {
      const res = await postEarn(path, route.strategyBody("earn_strategy_missing"), null);

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
      expect(route.reached()).not.toHaveBeenCalled();
    }
  );

  it.each(Object.entries(MONEY_IN_ROUTES))(
    "%s runs a keyed request in its project's scope",
    async (path, route) => {
      const strategy = await seedStrategy();

      const res = await postEarn(path, route.strategyBody(strategy.id), key.raw);

      expect(res.status).toBe(200);
      expect(observedScopes).toEqual([
        { projectId: tenant.project.id, environment: "sandbox", cluster: "devnet" },
      ]);
    }
  );

  it.each(Object.entries(EXIT_ROUTES))(
    "%s runs a keyed exit in its project's scope",
    async (path, route) => {
      const positionId = await seedExternalWalletPosition({
        id: tenant.project.id,
        environment: "sandbox",
      });

      const res = await postEarn(path, route.positionBody(positionId), key.raw);

      expect(res.status).toBe(200);
      expect(observedScopes).toEqual([
        { projectId: tenant.project.id, environment: "sandbox", cluster: "devnet" },
      ]);
    }
  );
});

describe("cross-environment requests", () => {
  it.each(Object.entries(MONEY_IN_ROUTES))(
    "%s 404s a sandbox key naming a production strategy",
    async (path, route) => {
      const strategy = await seedStrategy({
        environment: "production",
        hostCluster: "mainnet-beta",
      });

      const res = await postEarn(path, route.strategyBody(strategy.id), key.raw);

      expect(res.status).toBe(404);
      expect(route.reached()).not.toHaveBeenCalled();
    }
  );

  it.each(Object.entries(EXIT_ROUTES))(
    "%s 404s a sandbox key naming a production position",
    async (path, route) => {
      const positionId = await seedExternalWalletPosition({
        id: "prj_keyless_scope_production",
        environment: "production",
      });

      const res = await postEarn(path, route.positionBody(positionId), key.raw);

      expect(res.status).toBe(404);
      expect(route.reached()).not.toHaveBeenCalled();
    }
  );

  it.each(Object.entries(EXIT_ROUTES))(
    "%s refuses an anonymous body that names only a position",
    async (path, route) => {
      const positionId = await seedExternalWalletPosition({
        id: tenant.project.id,
        environment: "sandbox",
      });

      const res = await postEarn(path, route.positionBody(positionId), null);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error).toMatchObject({
        code: "BAD_REQUEST",
        message: anonymousExitNeedsStrategy().message,
      });
      expect(route.reached()).not.toHaveBeenCalled();
    }
  );
});
