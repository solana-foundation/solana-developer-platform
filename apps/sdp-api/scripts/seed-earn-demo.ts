/**
 * LOCAL DEVELOPMENT ONLY — seeds an Earn strategy catalogue + NAV history into
 * a developer's own Postgres so /v1/earn/strategies and the Earn dashboard have
 * something to render without Ground credentials.
 *
 * This is NOT how deployed catalogue data arrives. The hourly catalogue-sync
 * cron (src/cron/earn-catalogue-sync.ts) pulls each provider's live catalogue
 * and is the real writer of earn_strategies; this script is an offline
 * convenience and the two share no code.
 *
 * Every row is a FIXTURE that imitates Ground's sandbox yield-source catalogue —
 * ids, names, APYs, source kinds, redemption delays, curators and TVLs copied
 * from a sandbox sync on 2026-08-04 — because a catalogue of invented products
 * teaches local dev the wrong thing. The numbers are frozen snapshots, not live
 * truth; only the sync tracks the real ones.
 *
 * Fixtures stay distinguishable from synced rows, and that is what the
 * `seed-demo-` provider_reference prefix buys (earn_strategies has no
 * created_by column — the catalogue is platform-global):
 *   - it is the ownership marker `--clean` deletes by;
 *   - it keeps fixtures out of the sync's key space, since synced rows carry
 *     Ground's bare ids — so seeding can never overwrite a synced row and
 *     `--clean` can never delete one;
 *   - it keeps the deliberately paused fixture paused: every sync pass
 *     re-asserts `active` for the references the provider lists, and Ground
 *     never lists a `seed-demo-` one.
 * Run both and the fixtures show up as twins beside the synced rows — the
 * prefix, and `riskMetadata.seedFixture`, are how you tell them apart.
 *
 * Rows go through the same write API the sync uses (upsertStrategy /
 * insertNavSnapshot) and are checked against the provider registry and its
 * declared support envelope with the exact helper the sync validates with, so
 * fixtures behave exactly like synced rows.
 *
 * Deposit mints are resolved from the pinned well-known-token catalogue for the
 * environment's cluster, never hand-typed. No share mints are seeded: a
 * fabricated mint address would point at an account that exists on no cluster.
 *
 * The catalogue is fixtures; the PROGRAM LINK is not. The seed also points the
 * primary local organization at ONE of the team's real Ground **sandbox**
 * portfolio wallets (SEED_PROVIDER_WALLET), so the dashboard opens onto a live
 * program — real allocation, real forward APY, a real Solana deposit address —
 * instead of the empty onboarding state a fresh install shows. Consequences
 * worth knowing:
 *   - one org gets one program, mirroring the UNIQUE (organization_id,
 *     environment, provider) product model; other local orgs are left unlinked
 *     rather than handed a sibling wallet that stands in for another org;
 *   - that wallet is SHARED with teammates, so funding it, updating its
 *     allocation through the wizard, or withdrawing from it changes what they
 *     see;
 *   - the seed only records the local link — it never calls Ground;
 *   - an organization that already has a program keeps it (the seed never
 *     repoints a wallet a developer created through the wizard);
 *   - but a link THIS SEED made follows the primary org on a re-run, so seeding
 *     before your first Clerk sign-in is recoverable — see seedProviderWallets;
 *   - `--clean` removes only links labelled SEED_WALLET_LABEL and leaves the
 *     Ground wallet itself untouched.
 *
 * Idempotent: strategies upsert on (provider, provider_reference, environment)
 * so re-running updates exactly those rows in place (ids stay stable, positions
 * opened against them survive) and NAV points upsert on (strategy_id, as_of).
 *
 *   pnpm -C apps/sdp-api db:seed:earn                            # sandbox fixtures + NAV history
 *   pnpm -C apps/sdp-api db:seed:earn -- --days 30               # longer NAV history
 *   pnpm -C apps/sdp-api db:seed:earn -- --clean                 # remove the fixtures again
 *
 * Sandbox-only, and the target DATABASE_URL must be a loopback host — anything
 * else is refused before a connection is opened.
 */

import { isStrategyWithinDeclaredSupport, resolveEarnProviderClient } from "@sdp/earn";
import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type EarnApyType,
  type EarnDepositTokenSymbol,
  type EarnLiquidityTerm,
  type EarnStrategyRiskMetadata,
  type EarnStrategySourceKind,
  type EarnStrategyStatus,
  type SdpEnvironment,
  wellKnownMint,
} from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";
import { type AppDb, asTransactionalClient, closeDatabasePools, createDatabaseClient } from "@/db";
import type { EarnRepository, InsertEarnNavSnapshotInput } from "@/db/repositories";
import { createPostgresEarnRepository } from "@/db/repositories";

/** Ownership marker for seeded rows — see the header for what it protects. */
const SEED_REFERENCE_PREFIX = "seed-demo-";
// Ground is the only provider with an HTTP integration; the other registered
// ids are stubs, and a fixture under one of them would advertise a strategy
// nothing can quote, deposit into, or withdraw from.
const SEED_PROVIDER: EarnProviderId = "ground";
// Sandbox only. Production catalogue rows are the sync's business alone, and
// this script has no business writing anything a deployment reads.
const SEED_ENVIRONMENT: SdpEnvironment = "sandbox";
// Ground's depositToken enum is usdc|usdt and USDT has no devnet mint, so every
// sandbox source funds in USDC — the same single-mint shape the sync produces.
const SEED_DEPOSIT_TOKENS: readonly EarnDepositTokenSymbol[] = ["USDC"];
// Ground reports one apyBps per source with no fixed/variable distinction, so
// catalogue-sync maps every source to `variable`; fixtures mirror that instead
// of inventing fixed-rate products.
const SEED_APY_TYPE: EarnApyType = "variable";
const DEFAULT_NAV_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Ownership marker for seeded provider-wallet links. `--clean` deletes only
 * rows carrying it, so a wallet a developer created through the wizard is never
 * unlinked by a clean.
 */
const SEED_WALLET_LABEL = "Seeded sandbox wallet (local dev)";

/**
 * THIS IS A REAL GROUND SANDBOX PORTFOLIO WALLET — an actual provider resource
 * that exists in Ground's sandbox, not a fixture and not an invented id. It is
 * a live `POST /v2/wallets` wallet the team provisioned; the dashboard fetches
 * its true balance, positions, allocations, and Solana deposit address straight
 * from Ground. Sandbox only — never put a production wallet ref here.
 *
 * ONE wallet, linked to ONE organization — the local mirror of the product
 * model. SDP maps each organization to exactly one Ground portfolio wallet
 * (`earn_provider_wallets` UNIQUE (organization_id, environment, provider),
 * migration 0049): choosing a curator re-weights that wallet, it never
 * provisions a second one. Note this is SDP's model, NOT a Ground limit —
 * Ground has no concept of an SDP organization, and one Ground account can hold
 * many portfolio wallets (all SDP orgs share a single account per environment;
 * `readGroundConfig` resolves one API key, never a per-org credential). Sibling
 * wallets in the team's sandbox account therefore stand in for OTHER
 * organizations, so the seed must not hand them to yours.
 *
 * It is linked so local dev opens onto a live program instead of an empty
 * onboarding screen. Live provider resource, not a fixture:
 *   - the dashboard reads its real balance, allocation, and deposit address;
 *   - SANDBOX only — never a production wallet ref;
 *   - it is SHARED, so state you change here (funding, a strategy update
 *     through the wizard, a withdrawal) is state your teammates also see.
 * Nothing here writes to Ground; the seed only records the link locally.
 *
 * Why THIS wallet: it is the one whose every value is reachable through SDP's
 * own surface. Its allocation is three Kamino USDC sources, so the overview
 * renders a real forward APY blended from target weights (`blendPositionApy`
 * weights by target when nothing is deployed yet), and you fund it yourself by
 * sending devnet USDC to its Solana deposit address — which exercises the actual
 * two-phase deposit. It reads $0 until you do, and that is the point: a zero you
 * can act on beats a balance you cannot.
 *
 * DELIBERATELY NOT the sandbox's funded wallets, and this is measured, not
 * assumed. Their balances sit as USDT cash on a non-Solana rail, and Ground
 * enforces the lane split at the API:
 *
 *     USDC -> solana_devnet      409  insufficient_funds (lane withdrawable 0)
 *     USDT -> solana_devnet      400  "destinationChain must be one of: ..."
 *     USDT -> <its own rail>     200  withdrawable 5.000000
 *
 * So a funded wallet makes the dashboard show a withdrawable balance that SDP
 * cannot withdraw: `balance.withdrawableUsd` is a wallet-level total, the exit
 * is per-lane, and the withdraw modal caps on the total. Seeding that wallet
 * hands every developer a program whose money is unreachable and whose "max"
 * button 409s — which reads as an SDP bug and is not one. Verified against
 * Ground's sandbox on 2026-08-04.
 *
 * Keep this ref on the Solana rail. The surface is Solana-only (ADR 0002
 * invariant 5) and a seeded wallet must not imply otherwise — which is also why
 * `mapPosition` synthesizes position labels rather than passing the provider's
 * chain-bearing ones through.
 */
const SEED_PROVIDER_WALLET: { ref: string; note: string } = {
  ref: "eed99909-b2d4-4f01-af32-461e500d292d",
  note: "three-source Kamino USDC allocation, $0 until you deposit devnet USDC",
};

// ── Fixture catalogue ───────────────────────────────────────────────────────
// Ten of Ground's sandbox yield sources, trimmed to a spread the dashboard
// exercises well: several curators holding more than one opportunity, instant
// and delayed liquidity, DeFi and tokenized RWA, and a high-APY outlier.

interface SeedStrategy {
  /** Ground's real sandbox yield-source id; the seeded reference prefixes it. */
  groundYieldSourceId: string;
  name: string;
  sourceKind: EarnStrategySourceKind;
  /** Ground's `protocol`, lowercased — the open registry the sync writes. */
  underlyingSource: string;
  /** Decimal string, e.g. "0.0506" = 5.06%. */
  apy: string;
  liquidityTerm: EarnLiquidityTerm;
  redemptionDelayDays: number | null;
  /** Open curator id — @sdp/types maps known ones to display labels. */
  curator: string;
  /** Anchor TVL in USD; NAV snapshots wobble around it. */
  tvlUsd: number;
  /** Defaults to active — exactly one fixture is paused on purpose. */
  status?: EarnStrategyStatus;
}

const SEED_STRATEGIES: readonly SeedStrategy[] = [
  {
    groundYieldSourceId: "kamino-superstate-usdc",
    name: "Kamino Superstate USDC",
    sourceKind: "defi",
    underlyingSource: "kamino",
    apy: "0.0154",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    curator: "kamino",
    tvlUsd: 8_400_000,
  },
  {
    groundYieldSourceId: "kamino-allez-usdc",
    name: "Kamino Allez USDC",
    sourceKind: "defi",
    underlyingSource: "kamino",
    apy: "0.0506",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    curator: "kamino",
    tvlUsd: 15_600_000,
  },
  {
    groundYieldSourceId: "kamino-steakhouse-usdc",
    name: "Kamino Steakhouse USDC",
    sourceKind: "defi",
    underlyingSource: "kamino",
    apy: "0.0392",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    curator: "steakhouse",
    tvlUsd: 20_000_000,
  },
  {
    groundYieldSourceId: "morpho-steakhouse-usdc",
    name: "Morpho Steakhouse USDC Prime",
    sourceKind: "defi",
    underlyingSource: "morpho",
    apy: "0.0352",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    curator: "steakhouse",
    tvlUsd: 76_900_000,
  },
  {
    groundYieldSourceId: "morpho-gauntlet-usdc",
    name: "Morpho Gauntlet USDC Prime",
    sourceKind: "defi",
    underlyingSource: "morpho",
    apy: "0.037",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    curator: "gauntlet",
    tvlUsd: 28_400_000,
  },
  {
    groundYieldSourceId: "kamino-gauntlet-frontier-usdc",
    name: "Kamino Gauntlet USDC Frontier",
    sourceKind: "defi",
    underlyingSource: "kamino",
    apy: "0.0478",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    curator: "gauntlet",
    tvlUsd: 390_000,
  },
  {
    // The catalogue's high-APY outlier: exercises sorting, the enhanced risk
    // tier, and the copy that has to sit next to a rate like this.
    groundYieldSourceId: "morpho-august-usdc-v2",
    name: "Morpho August USDC V2",
    sourceKind: "defi",
    underlyingSource: "morpho",
    apy: "0.0815",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    curator: "morpho",
    tvlUsd: 1_600_000,
  },
  {
    // DeFi with a redemption delay — the combination that catches code assuming
    // "defi ⇒ instant".
    groundYieldSourceId: "syrup-usdc",
    name: "Syrup USDC",
    sourceKind: "defi",
    underlyingSource: "maple",
    apy: "0.0492",
    liquidityTerm: "delayed",
    redemptionDelayDays: 1,
    curator: "maple",
    tvlUsd: 1_090_000_000,
  },
  {
    groundYieldSourceId: "ground-jaaa-usdc-vault",
    name: "Janus Henderson JAAA (USDC)",
    sourceKind: "rwa",
    underlyingSource: "centrifuge",
    apy: "0.037",
    liquidityTerm: "delayed",
    redemptionDelayDays: 2,
    curator: "centrifuge",
    tvlUsd: 685_000_000,
  },
  {
    // Paused on purpose: a delayed tokenized-treasury vault is the sharpest
    // exit-safety case, so this row exercises the ADR 0002 split (deposits
    // blocked, T+2 withdrawals still quoted) and the includeInactive listing
    // path. Fixtures can hold a pause because the sync never lists their
    // references and so never re-asserts `active` over them.
    groundYieldSourceId: "ground-jtrsy-usdc-vault",
    name: "Janus Henderson JTRSY tokenized by Centrifuge",
    sourceKind: "rwa",
    underlyingSource: "centrifuge",
    apy: "0.0328",
    liquidityTerm: "delayed",
    redemptionDelayDays: 2,
    curator: "centrifuge",
    tvlUsd: 881_000_000,
    status: "paused",
  },
];

// ── Row construction ────────────────────────────────────────────────────────

function seededReference(strategy: SeedStrategy): string {
  return `${SEED_REFERENCE_PREFIX}${strategy.groundYieldSourceId}`;
}

/**
 * Curators publish risk tiers; Ground reports none, so fixtures band by APY.
 * This is the one field here the sync does not produce, kept because the
 * dashboard's tier copy (EARN_RISK_TIERS) is otherwise dead in local dev.
 */
function riskTierForApy(apy: string): string {
  const rate = Number(apy);
  if (rate < 0.04) {
    return "conservative";
  }
  return rate < 0.06 ? "balanced" : "enhanced";
}

function buildRiskMetadata(strategy: SeedStrategy): EarnStrategyRiskMetadata {
  return {
    curator: strategy.curator,
    riskTier: riskTierForApy(strategy.apy),
    // Same field the sync copies from Ground, and the anchor the NAV series
    // wobbles around — held in step so catalogue and NAV never disagree.
    tvlUsd: strategy.tvlUsd,
    // Fixture marker, visible everywhere risk metadata is (API payloads, psql),
    // so a seeded row never reads as live truth. --clean keys off the
    // provider_reference prefix, not this flag.
    seedFixture: true,
  };
}

/**
 * Deposit symbols → the environment's verified mint addresses. Symbols with no
 * mint on the cluster are dropped, exactly like a real provider could not
 * accept them there.
 */
function resolveDepositMints(): string[] {
  const cluster = CLUSTER_BY_SDP_ENVIRONMENT[SEED_ENVIRONMENT];
  const mints = SEED_DEPOSIT_TOKENS.flatMap((symbol) => {
    const mint = wellKnownMint(symbol, cluster);
    return mint ? [mint] : [];
  });
  if (mints.length === 0) {
    throw new Error(`None of ${SEED_DEPOSIT_TOKENS.join("/")} has a mint on ${cluster}`);
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
      tvl: (strategy.tvlUsd * (1 + 0.03 * Math.sin(index / 2))).toFixed(2),
      asOf: new Date(todayUtcMs - age * DAY_MS).toISOString(),
    };
  });
}

// ── Database ────────────────────────────────────────────────────────────────

async function deleteSeeded(db: AppDb): Promise<number> {
  // earn_nav_snapshots cascade from earn_strategies; earn_positions FKs are
  // RESTRICT, so cleaning fails loudly if positions were opened against
  // seeded strategies rather than orphaning them.
  return db.execute(
    "DELETE FROM earn_strategies WHERE environment = ? AND provider_reference LIKE ?",
    [SEED_ENVIRONMENT, `${SEED_REFERENCE_PREFIX}%`]
  );
}

async function deleteSeededWallets(db: AppDb): Promise<number> {
  return db.execute(
    "DELETE FROM earn_provider_wallets WHERE environment = ? AND provider = ? AND label = ?",
    [SEED_ENVIRONMENT, SEED_PROVIDER, SEED_WALLET_LABEL]
  );
}

interface LocalOrganization {
  organizationId: string;
  projectId: string;
  createdBy: string;
  slug: string;
}

/**
 * The single local organization that gets the seeded program: the developer's
 * own Clerk-backed org, ordered ahead of the `db:seed:local` test fixture, since
 * the dashboard only ever looks at the org you are signed into.
 *
 * Returns at most one row. Other local orgs are left without a program on
 * purpose — a sibling org's program is a wallet of its own in Ground, and this
 * seed has exactly one ref to give.
 *
 * The ordering is **fully deterministic**, which matters more than the sort key
 * itself: because the seeded link follows whichever org this returns, an
 * ambiguous ORDER BY would let two runs disagree and bounce the program between
 * orgs, leaving the dashboard on an empty onboarding screen every other run.
 * `created_at` is TEXT and is written per-second, so two orgs provisioned in the
 * same second tie on it — and a multi-project or multi-member org yields several
 * rows for one org. Every remaining key is therefore broken by id.
 */
async function findPrimaryLocalOrganization(db: AppDb): Promise<LocalOrganization | undefined> {
  const organizations = await db.queryMany<LocalOrganization>(
    `SELECT o.id AS "organizationId",
            p.id AS "projectId",
            m.user_id AS "createdBy",
            o.slug AS slug
       FROM organizations o
       JOIN projects p
         ON p.organization_id = o.id AND p.environment = ?
       JOIN organization_members m
         ON m.organization_id = o.id
      WHERE o.status = 'active'
      GROUP BY o.id, p.id, m.user_id, o.slug, o.created_at
      ORDER BY (o.id = 'org_test123456789'), o.created_at DESC,
               o.id ASC, p.id ASC, m.user_id ASC
      LIMIT 1`,
    [SEED_ENVIRONMENT]
  );
  return organizations[0];
}

/**
 * Links the shared sandbox wallet to the primary local organization — one org,
 * one program, mirroring the UNIQUE (organization_id, environment, provider)
 * product model.
 *
 * Never repoints a program a developer created through the wizard: that link is
 * theirs and silently swapping its provider wallet would strand it. A link this
 * seed made (identified by SEED_WALLET_LABEL) is a different matter — it MOVES
 * to follow the primary org.
 *
 * Why moving matters, and the ordering trap it removes: on a fresh machine the
 * only organization is the `db:seed:local` test fixture, so an early
 * `db:seed:earn` lands the program there. Signing into Clerk then provisions
 * your real org, which becomes primary — and without the move, re-running the
 * seed would leave the program stranded on the test org while the dashboard you
 * are actually looking at shows an empty onboarding screen forever. Re-running
 * the seed after first sign-in now just works.
 */
async function seedProviderWallets(
  repo: EarnRepository,
  db: AppDb
): Promise<{ linked: number; kept: number; moved: boolean; skipped: boolean }> {
  const organization = await findPrimaryLocalOrganization(db);
  if (!organization) {
    return { linked: 0, kept: 0, moved: false, skipped: true };
  }

  const existing = await repo.getProviderWallet({
    organizationId: organization.organizationId,
    environment: SEED_ENVIRONMENT,
    provider: SEED_PROVIDER,
  });
  if (existing) {
    console.log(`  ${organization.slug}: kept existing program (${existing.provider_wallet_ref})`);
    return { linked: 0, kept: 1, moved: false, skipped: false };
  }

  // The move is one transaction: the delete and the insert must land together or
  // not at all. Committing the delete on its own would leave no program link if
  // the insert then failed, putting the dashboard back on the empty onboarding
  // screen — the exact state this function exists to prevent.
  const moved = await db.transaction(async (tx) => {
    const txRepo = createPostgresEarnRepository(asTransactionalClient(tx));
    // Only ever removes rows this seed created; a wizard-made link carries a
    // different label and is left alone.
    const removed = await tx.execute(
      "DELETE FROM earn_provider_wallets WHERE environment = ? AND provider = ? AND label = ?",
      [SEED_ENVIRONMENT, SEED_PROVIDER, SEED_WALLET_LABEL]
    );
    await txRepo.insertProviderWallet({
      organizationId: organization.organizationId,
      projectId: organization.projectId,
      environment: SEED_ENVIRONMENT,
      provider: SEED_PROVIDER,
      providerWalletRef: SEED_PROVIDER_WALLET.ref,
      label: SEED_WALLET_LABEL,
      createdBy: organization.createdBy,
    });
    return removed > 0;
  });

  console.log(
    `  ${organization.slug}: ${moved ? "moved" : "linked"} ${SEED_PROVIDER_WALLET.ref} — ${SEED_PROVIDER_WALLET.note}`
  );
  return { linked: 1, kept: 0, moved, skipped: false };
}

async function seedStrategy(
  repo: EarnRepository,
  strategy: SeedStrategy,
  depositMints: string[],
  days: number,
  nowMs: number
): Promise<number> {
  const reference = seededReference(strategy);

  // Validate exactly as the catalogue-sync cron would before persisting.
  const client = resolveEarnProviderClient(SEED_PROVIDER);
  if (
    !isStrategyWithinDeclaredSupport(client.declaredSupport, {
      sourceKind: strategy.sourceKind,
      depositMints,
    })
  ) {
    throw new Error(`${reference} falls outside ${SEED_PROVIDER} declared support`);
  }

  const row = await repo.upsertStrategy({
    provider: SEED_PROVIDER,
    providerReference: reference,
    name: strategy.name,
    sourceKind: strategy.sourceKind,
    underlyingSource: strategy.underlyingSource,
    depositMints,
    shareMint: null,
    apyType: SEED_APY_TYPE,
    currentApy: strategy.apy,
    liquidityTerm: strategy.liquidityTerm,
    redemptionDelayDays: strategy.redemptionDelayDays,
    riskMetadata: buildRiskMetadata(strategy),
    status: strategy.status ?? "active",
    environment: SEED_ENVIRONMENT,
  });
  if (!row) {
    throw new Error(`Upsert returned no row for ${reference}`);
  }

  const navPoints = buildNavSeries(strategy, row.id, days, nowMs);
  for (const navPoint of navPoints) {
    await repo.insertNavSnapshot(navPoint);
  }
  return navPoints.length;
}

// ── Entry point ─────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Fixtures belong in a developer's own Postgres and nowhere else, so the target
 * must be a loopback host — the same restriction dev-local.mjs puts on local
 * state resets. Checked before any client exists, so a rejected URL never gets
 * a connection, let alone a write.
 */
function requireLocalDatabase(databaseUrl: string): void {
  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid connection URL");
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing to touch ${hostname}: db:seed:earn writes local-development fixtures and only runs against a local database (localhost / 127.0.0.1 / ::1).`
    );
  }
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function summarize(): void {
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

  console.log(`  provider  : ${SEED_PROVIDER} fixtures imitating its sandbox catalogue`);
  console.log(`  cluster   : ${CLUSTER_BY_SDP_ENVIRONMENT[SEED_ENVIRONMENT]} mints`);
  console.log(`  kinds     : ${count((s) => s.sourceKind)}  (every APY ${SEED_APY_TYPE})`);
  console.log(`  protocols : ${count((s) => s.underlyingSource)}`);
  console.log(
    `  liquidity : ${count((s) => s.liquidityTerm)}  |  ${count((s) => s.status ?? "active")}`
  );
  console.log(`  curators  : ${count((s) => s.curator)}`);
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL?.trim() ||
    // biome-ignore lint/security/noSecrets: local Docker Postgres default, same as the migrate scripts.
    "postgresql://sdp:sdp@127.0.0.1:5432/sdp";
  requireLocalDatabase(databaseUrl);

  // Rejected rather than ignored: silently seeding sandbox for someone who
  // asked for production is the same footgun, only quieter.
  if (process.argv.includes("--environment")) {
    throw new Error(
      "--environment is gone: db:seed:earn only ever writes sandbox fixtures, and only to a local database."
    );
  }
  const cleanOnly = process.argv.includes("--clean");
  const days = Number(readFlag("days") ?? DEFAULT_NAV_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("--days must be an integer between 1 and 365");
  }

  const db = createDatabaseClient(databaseUrl);
  const repo = createPostgresEarnRepository(db);

  try {
    if (cleanOnly) {
      const removedWallets = await deleteSeededWallets(db);
      const removed = await deleteSeeded(db);
      console.log(
        `Done — removed ${removed} seeded ${SEED_ENVIRONMENT} strategies and ${removedWallets} seeded program link(s). The Ground sandbox wallets themselves are untouched.`
      );
      return;
    }

    const depositMints = resolveDepositMints();
    const nowMs = Date.now();
    let navPointCount = 0;
    for (const strategy of SEED_STRATEGIES) {
      navPointCount += await seedStrategy(repo, strategy, depositMints, days, nowMs);
    }

    const { total } = await repo.listStrategies({
      environment: SEED_ENVIRONMENT,
      includeInactive: true,
      limit: 1,
      offset: 0,
    });
    console.log(
      `Upserted ${SEED_STRATEGIES.length} strategies with ${navPointCount} NAV points (${days} days each).`
    );
    summarize();
    console.log(`  catalogue now holds ${total} ${SEED_ENVIRONMENT} strategies in total.`);

    console.log("\nLinking the shared Ground sandbox program (live provider state):");
    const wallets = await seedProviderWallets(repo, db);
    if (wallets.skipped) {
      console.log("  no local organization found — run db:seed:local first, or sign in once.");
    } else {
      console.log("  one organization, one program — other local orgs stay unlinked by design.");
      if (wallets.moved) {
        console.log(
          "  (moved the seeded link off a previous org to follow the one you sign into.)"
        );
      }
    }
  } finally {
    await closeDatabasePools().catch(() => {});
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
