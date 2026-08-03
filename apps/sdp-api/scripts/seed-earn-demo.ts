/**
 * Seeds a realistic Earn strategy catalogue + NAV history into a local
 * database, so /v1/earn/strategies is browsable before any vault-infra
 * provider integration is live.
 *
 * Every row goes through the same write API the catalogue-sync cron uses
 * (upsertStrategy / insertNavSnapshot), and every strategy is checked against
 * the provider registry and its declared support envelope with the exact
 * helper the sync validates with — so seeded rows behave exactly like synced
 * ones.
 *
 * Deposit mints are resolved from the pinned well-known-token catalogue for
 * the environment's cluster, never hand-typed; a symbol with no verified mint
 * on that cluster (USDT on devnet) is dropped. No share mints are seeded: a
 * fabricated mint address would point at an account that exists on no
 * cluster, and the stub providers issue none yet.
 *
 * Idempotent: strategies upsert on (provider, provider_reference, environment)
 * and every seeded reference carries the `seed-demo-` prefix, so re-running
 * updates exactly those rows in place (ids stay stable, positions opened
 * against them survive) and NAV points upsert on (strategy_id, as_of).
 *
 *   pnpm -C apps/sdp-api db:seed:earn                            # sandbox catalogue
 *   pnpm -C apps/sdp-api db:seed:earn -- --environment production
 *   pnpm -C apps/sdp-api db:seed:earn -- --days 30               # longer NAV history
 *   pnpm -C apps/sdp-api db:seed:earn -- --clean                 # remove them again
 */

import { isStrategyWithinDeclaredSupport, resolveEarnProviderClient } from "@sdp/earn";
import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type EarnApyType,
  type EarnDepositTokenSymbol,
  type EarnKnownUnderlyingSource,
  type EarnLiquidityTerm,
  type EarnStrategyRiskMetadata,
  type EarnStrategySourceKind,
  type EarnStrategyStatus,
  type SdpEnvironment,
  wellKnownMint,
} from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";
import { type AppDb, closeDatabasePools, createDatabaseClient } from "@/db";
import type { EarnRepository, InsertEarnNavSnapshotInput } from "@/db/repositories";
import { createPostgresEarnRepository } from "@/db/repositories";

// earn_strategies has no created_by column (the catalogue is platform-global),
// so this provider_reference prefix is the ownership marker --clean deletes by.
const SEED_REFERENCE_PREFIX = "seed-demo-";
const DEFAULT_NAV_DAYS = 14;
const DAY_MS = 86_400_000;

// ── Strategy catalogue ──────────────────────────────────────────────────────
// Hand-curated rather than generated: a handful of rows is enough for the
// catalogue UI, and each one stays a plausible product of its provider —
// source kinds inside the provider's declared support, underlying sources
// from the known registry, curators from the known-label registry.

interface SeedStrategy {
  provider: EarnProviderId;
  reference: `${typeof SEED_REFERENCE_PREFIX}${string}`;
  name: string;
  sourceKind: EarnStrategySourceKind;
  underlyingSource: EarnKnownUnderlyingSource;
  depositTokens: readonly EarnDepositTokenSymbol[];
  apyType: EarnApyType;
  /** Decimal string, e.g. "0.058" = 5.8%. */
  apy: string;
  liquidityTerm: EarnLiquidityTerm;
  redemptionDelayDays: number | null;
  status: EarnStrategyStatus;
  riskMetadata: EarnStrategyRiskMetadata;
  /** Anchor TVL in deposit-asset display units; NAV snapshots wobble around it. */
  tvl: number;
}

const SEED_STRATEGIES: readonly SeedStrategy[] = [
  {
    provider: "ground",
    reference: "seed-demo-kamino-usdc",
    name: "Kamino USDC Lending",
    sourceKind: "defi",
    underlyingSource: "kamino",
    depositTokens: ["USDC"],
    apyType: "variable",
    apy: "0.0582",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    status: "active",
    riskMetadata: {
      curator: "steakhouse",
      riskTier: "conservative",
      frameworkUrl: "https://steakhouse.example.com/frameworks/kamino-usdc",
    },
    tvl: 12_400_000,
  },
  {
    provider: "ground",
    reference: "seed-demo-buidl-treasury",
    name: "BUIDL Treasury Reserve",
    sourceKind: "rwa",
    underlyingSource: "buidl",
    depositTokens: ["USDC"],
    apyType: "fixed",
    apy: "0.0468",
    liquidityTerm: "delayed",
    redemptionDelayDays: 1,
    status: "active",
    riskMetadata: {
      curator: "sentora",
      riskTier: "conservative",
      frameworkUrl: "https://sentora.example.com/frameworks/buidl-treasury",
    },
    tvl: 26_500_000,
  },
  {
    provider: "ground",
    reference: "seed-demo-syrup-usdc",
    name: "Syrup USDC Secured Lending",
    sourceKind: "defi",
    underlyingSource: "syrup-usdc",
    depositTokens: ["USDC", "USDT"],
    apyType: "variable",
    apy: "0.0724",
    liquidityTerm: "delayed",
    redemptionDelayDays: 3,
    status: "active",
    riskMetadata: {
      curator: "steakhouse",
      riskTier: "elevated",
      frameworkUrl: "https://steakhouse.example.com/frameworks/syrup-usdc",
    },
    tvl: 9_600_000,
  },
  {
    // Paused on purpose: exercises the ADR 0002 exit-safety split (deposits
    // blocked, withdrawals still quoted) and the includeInactive listing path.
    provider: "ground",
    reference: "seed-demo-benji-money-fund",
    name: "Benji Government Money Fund",
    sourceKind: "rwa",
    underlyingSource: "benji",
    depositTokens: ["USDC", "USDG"],
    apyType: "fixed",
    apy: "0.0441",
    liquidityTerm: "delayed",
    redemptionDelayDays: 2,
    status: "paused",
    riskMetadata: {
      curator: "sentora",
      riskTier: "conservative",
      frameworkUrl: "https://sentora.example.com/frameworks/benji-money-fund",
    },
    tvl: 18_200_000,
  },
  {
    provider: "perena",
    reference: "seed-demo-jup-lend-stable",
    name: "Jupiter Lend Stable Pool",
    sourceKind: "defi",
    underlyingSource: "jup-lend",
    depositTokens: ["USDG", "USDC"],
    apyType: "variable",
    apy: "0.0645",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    status: "active",
    riskMetadata: {
      curator: "gauntlet",
      riskTier: "moderate",
      frameworkUrl: "https://gauntlet.example.com/frameworks/jup-lend-stable",
    },
    tvl: 7_800_000,
  },
  {
    provider: "perena",
    reference: "seed-demo-usde-carry",
    name: "USDe Delta-Neutral Carry",
    sourceKind: "defi",
    underlyingSource: "usde",
    depositTokens: ["USDC"],
    apyType: "variable",
    apy: "0.0693",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    status: "active",
    riskMetadata: {
      curator: "gauntlet",
      riskTier: "elevated",
      frameworkUrl: "https://gauntlet.example.com/frameworks/usde-carry",
    },
    tvl: 5_300_000,
  },
];

// ── Row construction ────────────────────────────────────────────────────────

/**
 * Deposit symbols → the environment's verified mint addresses. Symbols with
 * no mint on the cluster (USDT has no devnet deployment) are dropped, exactly
 * like a real provider could not accept them there.
 */
function resolveDepositMints(strategy: SeedStrategy, environment: SdpEnvironment): string[] {
  const cluster = CLUSTER_BY_SDP_ENVIRONMENT[environment];
  const mints = strategy.depositTokens.flatMap((symbol) => {
    const mint = wellKnownMint(symbol, cluster);
    return mint ? [mint] : [];
  });
  if (mints.length === 0) {
    throw new Error(
      `${strategy.reference}: none of ${strategy.depositTokens.join("/")} has a mint on ${cluster}`
    );
  }
  return mints;
}

/**
 * Daily midnight-UTC NAV points, oldest first: share price compounds at
 * apy/365 from 1.0 up to today, TVL wobbles mildly around the anchor.
 * Deterministic for a given day, and as_of values repeat across runs so
 * insertNavSnapshot updates the same points in place.
 */
function buildNavSeries(
  strategy: SeedStrategy,
  strategyId: string,
  days: number,
  nowMs: number
): InsertEarnNavSnapshotInput[] {
  const today = new Date(nowMs);
  const todayUtcMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const dailyRate = Number(strategy.apy) / 365;

  return Array.from({ length: days }, (_, index) => {
    const age = days - 1 - index;
    return {
      strategyId,
      sharePrice: ((1 + dailyRate) ** index).toFixed(8),
      apy: strategy.apy,
      tvl: (strategy.tvl * (1 + 0.03 * Math.sin(index / 2))).toFixed(2),
      asOf: new Date(todayUtcMs - age * DAY_MS).toISOString(),
    };
  });
}

// ── Database ────────────────────────────────────────────────────────────────

async function deleteSeeded(db: AppDb, environment: SdpEnvironment): Promise<number> {
  // earn_nav_snapshots cascade from earn_strategies; earn_positions FKs are
  // RESTRICT, so cleaning fails loudly if positions were opened against
  // seeded strategies rather than orphaning them.
  return db.execute(
    "DELETE FROM earn_strategies WHERE environment = ? AND provider_reference LIKE ?",
    [environment, `${SEED_REFERENCE_PREFIX}%`]
  );
}

async function seedStrategy(
  repo: EarnRepository,
  strategy: SeedStrategy,
  environment: SdpEnvironment,
  days: number,
  nowMs: number
): Promise<number> {
  const depositMints = resolveDepositMints(strategy, environment);

  // Validate exactly as the catalogue-sync cron would before persisting.
  const client = resolveEarnProviderClient(strategy.provider);
  if (
    !isStrategyWithinDeclaredSupport(client.declaredSupport, {
      sourceKind: strategy.sourceKind,
      depositMints,
    })
  ) {
    throw new Error(`${strategy.reference} falls outside ${strategy.provider} declared support`);
  }

  const row = await repo.upsertStrategy({
    provider: strategy.provider,
    providerReference: strategy.reference,
    name: strategy.name,
    sourceKind: strategy.sourceKind,
    underlyingSource: strategy.underlyingSource,
    depositMints,
    shareMint: null,
    apyType: strategy.apyType,
    currentApy: strategy.apy,
    liquidityTerm: strategy.liquidityTerm,
    redemptionDelayDays: strategy.redemptionDelayDays,
    riskMetadata: strategy.riskMetadata,
    status: strategy.status,
    environment,
  });
  if (!row) {
    throw new Error(`Upsert returned no row for ${strategy.reference}`);
  }

  const navPoints = buildNavSeries(strategy, row.id, days, nowMs);
  for (const navPoint of navPoints) {
    await repo.insertNavSnapshot(navPoint);
  }
  return navPoints.length;
}

// ── Entry point ─────────────────────────────────────────────────────────────

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function summarize(environment: SdpEnvironment): void {
  const count = (keyOf: (s: SeedStrategy) => string) => {
    const counts = new Map<string, number>();
    for (const strategy of SEED_STRATEGIES) {
      counts.set(keyOf(strategy), (counts.get(keyOf(strategy)) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join("  ");
  };

  console.log(`  cluster   : ${CLUSTER_BY_SDP_ENVIRONMENT[environment]} mints`);
  console.log(`  providers : ${count((s) => s.provider)}`);
  console.log(`  kinds     : ${count((s) => s.sourceKind)}  |  ${count((s) => s.apyType)}`);
  console.log(`  liquidity : ${count((s) => s.liquidityTerm)}  |  ${count((s) => s.status)}`);
  console.log(`  curators  : ${count((s) => s.riskMetadata.curator ?? "none")}`);
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL?.trim() ||
    // biome-ignore lint/security/noSecrets: local Docker Postgres default, same as the migrate scripts.
    "postgresql://sdp:sdp@127.0.0.1:5432/sdp";
  const cleanOnly = process.argv.includes("--clean");
  const environment = readFlag("environment") ?? "sandbox";
  const days = Number(readFlag("days") ?? DEFAULT_NAV_DAYS);

  if (environment !== "sandbox" && environment !== "production") {
    throw new Error("--environment must be 'sandbox' or 'production'");
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("--days must be an integer between 1 and 365");
  }

  const db = createDatabaseClient(databaseUrl);
  const repo = createPostgresEarnRepository(db);

  try {
    if (cleanOnly) {
      const removed = await deleteSeeded(db, environment);
      console.log(`Done — removed ${removed} seeded ${environment} strategies.`);
      return;
    }

    const nowMs = Date.now();
    let navPointCount = 0;
    for (const strategy of SEED_STRATEGIES) {
      navPointCount += await seedStrategy(repo, strategy, environment, days, nowMs);
    }

    const { total } = await repo.listStrategies({
      environment,
      includeInactive: true,
      limit: 1,
      offset: 0,
    });
    console.log(
      `Upserted ${SEED_STRATEGIES.length} strategies with ${navPointCount} NAV points (${days} days each).`
    );
    summarize(environment);
    console.log(`  catalogue now holds ${total} ${environment} strategies in total.`);
  } finally {
    await closeDatabasePools().catch(() => {});
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
