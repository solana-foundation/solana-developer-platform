import {
  EARN_PORTFOLIO_TOKENS,
  type EarnPortfolioAllocationInput,
  type EarnPortfolioToken,
  type EarnStrategy,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";

/**
 * Pure allocation model for the deposit wizard, over live `EarnStrategy`
 * catalogue rows. The program API (PUT /v1/earn/program) authors strategy
 * weights as percentages on a 0.1 grid that must sum to exactly 100 per token
 * group, so all arithmetic here happens in integer tenths-of-a-percent — never
 * floating-point accumulation — to keep that sum check exact.
 */

const TENTHS_PER_WHOLE = 1000;

/** Portfolio token (usdc/usdt) behind a deposit mint, when the rail routes it. */
export function portfolioTokenForMint(mint: string): EarnPortfolioToken | undefined {
  const symbol = WELL_KNOWN_TOKEN_BY_MINT.get(mint)?.symbol.toLowerCase();
  return EARN_PORTFOLIO_TOKENS.find((token) => token === symbol);
}

/** Strategies a curator program can fund with one portfolio token. */
export interface CuratorTokenGroup {
  token: EarnPortfolioToken;
  strategies: readonly EarnStrategy[];
}

/** Group a curator's strategies by fundable portfolio token, in registry order. */
export function curatorTokenGroups(
  strategies: readonly EarnStrategy[]
): readonly CuratorTokenGroup[] {
  return EARN_PORTFOLIO_TOKENS.flatMap((token) => {
    const eligible = strategies.filter((strategy) =>
      strategy.depositMints.some((mint) => portfolioTokenForMint(mint) === token)
    );
    return eligible.length > 0 ? [{ token, strategies: eligible }] : [];
  });
}

/** Raw weight inputs (percent strings, as typed) keyed by strategy id. */
export type WeightInputs = Readonly<Record<string, string>>;

/** Integer tenths for a percent value on the 0.1 grid within [0, 100], else undefined. */
function weightTenths(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0 || value > 100) return undefined;
  const tenths = Math.round(value * 10);
  return Math.abs(value * 10 - tenths) < 1e-6 ? tenths : undefined;
}

/** Split 100% across ids as evenly as the 0.1% grid allows, in caller order. */
export function evenAllocation(ids: readonly string[]): Record<string, number> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};

  const base = Math.floor(TENTHS_PER_WHOLE / unique.length);
  const remainder = TENTHS_PER_WHOLE % unique.length;

  return Object.fromEntries(
    unique.map((id, index) => [id, (base + (index < remainder ? 1 : 0)) / 10])
  );
}

/** Even default weight inputs for every token group of a curator. */
export function defaultWeightInputs(
  groups: readonly CuratorTokenGroup[]
): Partial<Record<EarnPortfolioToken, WeightInputs>> {
  return Object.fromEntries(
    groups.map((group) => [
      group.token,
      Object.fromEntries(
        Object.entries(evenAllocation(group.strategies.map((strategy) => strategy.id))).map(
          ([id, pct]) => [id, String(pct)]
        )
      ),
    ])
  );
}

export type AllocationIssue = "malformed" | "sum";

export interface ParsedAllocation {
  /** Positive parsed percents by strategy id (blanks and zeros drop out). */
  weights: Record<string, number>;
  /** Sum of the parseable weights, for the "% allocated" indicator. */
  totalPct: number;
  issue?: AllocationIssue;
}

/**
 * Parse weight inputs against the API grid: every entry blank or a percent in
 * [0, 100] on the 0.1 grid, with the positive entries summing to exactly 100.
 */
export function parseAllocation(inputs: WeightInputs): ParsedAllocation {
  const weights: Record<string, number> = {};
  let totalTenths = 0;
  let malformed = false;

  for (const [id, raw] of Object.entries(inputs)) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const tenths = weightTenths(Number(trimmed));
    if (tenths === undefined) {
      malformed = true;
      continue;
    }
    totalTenths += tenths;
    if (tenths > 0) weights[id] = tenths / 10;
  }

  const totalPct = totalTenths / 10;
  if (malformed) return { weights, totalPct, issue: "malformed" };
  if (totalTenths !== TENTHS_PER_WHOLE) return { weights, totalPct, issue: "sum" };
  return { weights, totalPct };
}

/**
 * Portfolio APY for one token group as a decimal (0.052 = 5.2%). Weights are
 * portfolio percentages, so an incomplete allocation leaves the remainder at
 * zero yield rather than renormalizing it.
 */
export function weightedApy(
  strategies: readonly EarnStrategy[],
  weights: Readonly<Record<string, number>>
): number {
  return strategies.reduce((total, strategy) => {
    const pct = weights[strategy.id] ?? 0;
    const apy = Number(strategy.currentApy ?? 0);
    if (!Number.isFinite(pct) || !Number.isFinite(apy)) return total;
    return total + apy * (pct / 100);
  }, 0);
}

/**
 * PUT /earn/program request allocations: strategy weights keyed to the
 * provider's yield-source ids. Zero-weight strategies are omitted because the
 * API only accepts positive percents.
 */
export function buildAllocationInput(
  groups: readonly CuratorTokenGroup[],
  weightsByToken: Readonly<Partial<Record<EarnPortfolioToken, Record<string, number>>>>
): EarnPortfolioAllocationInput {
  const input: EarnPortfolioAllocationInput = {};
  for (const group of groups) {
    const weights = weightsByToken[group.token];
    if (!weights) continue;
    const allocations = group.strategies.flatMap((strategy) => {
      const pct = weights[strategy.id] ?? 0;
      return pct > 0 ? [{ yieldSourceId: strategy.providerReference, pct }] : [];
    });
    if (allocations.length > 0) input[group.token] = allocations;
  }
  return input;
}
