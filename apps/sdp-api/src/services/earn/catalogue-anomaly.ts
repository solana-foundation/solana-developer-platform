/**
 * Catalogue figure anomaly detection (PRO-1867, threat model EARN-010).
 *
 * The catalogue sync and the metrics refresh both take provider-reported
 * APY and TVL at face value and write them. A provider bug, a compromised
 * provider API, or an upstream oracle fault therefore reaches the comparison
 * table (and whatever a customer decides from it) with no check in between.
 * This module is that check: it diffs the incoming figures against what the
 * catalogue already holds and reports every move outside the bounds below as
 * an alertable event. It never blocks a write. A wrong rate on the shelf for
 * five minutes with a human paged beats a stale one held indefinitely by a
 * bound that guessed wrong, and the write paths' own invariants (update-only
 * refresh, gated admission) stay exactly where they were.
 *
 * Two events, both keyed for Grafana (`sdp-infra/kora/alert-rules`):
 *
 * - `sdp_api_earn_catalogue_figure_anomaly` (warn), one per strategy and
 *   metric that moved beyond a bound between two passes, or sits above the
 *   absolute APY ceiling. New rows are exempt from the diff (there is no
 *   "before"), never from the ceiling.
 * - `sdp_api_earn_catalogue_shelf_disappeared` (error), when a lane that
 *   previously stored rows receives a reliable empty catalogue for the same
 *   scope. Whether the pass then delists is the lane's business
 *   (`allowEmptyKeepSet`); the event reports the disappearance either way,
 *   because a fundable own shelf that the provider stopped listing is the
 *   more alarming case, not the less.
 *
 * The bounds are starting points chosen from what the shelf looks like today
 * (single-digit stablecoin APYs, seven-to-eight-figure TVLs), not measured
 * limits. Tighten or loosen them here; the alert rules key on the event, not
 * the numbers.
 */

import type { SolanaCluster } from "@sdp/types";
import { logEvent } from "@/runtime/money-path-events";

export const EARN_FIGURE_BOUNDS = {
  /** A rate multiplying or dividing by this between passes is a jump. */
  apyJumpRatio: 3,
  /** ...unless the absolute move is under half a percentage point (noise around zero). */
  apyMinAbsoluteDelta: 0.005,
  /** No stablecoin vault on the shelf pays this; above it the figure is wrong or the vault is not what it claims. */
  apyCeiling: 1,
  /** TVL multiplying or dividing by this between passes is a jump. */
  tvlJumpRatio: 3,
  /** ...unless the absolute move is under this many dollars (a tiny vault filling up is not an incident). */
  tvlMinAbsoluteDeltaUsd: 50_000,
} as const;

export type FigureAnomalySource = "catalogue_sync" | "metrics_refresh";

/** The stored side of the diff: one catalogued strategy's figures. */
export interface StoredStrategyFigures {
  providerReference: string;
  hostCluster: SolanaCluster;
  currentApy: string | null;
  tvlUsd: number | null;
}

/** The incoming side: what a pass is about to write for one reference. */
export interface IncomingStrategyFigures {
  providerReference: string;
  currentApy?: string | null;
  /** Read out of the incoming risk metadata; anything but a finite number is "no figure". */
  tvlUsd?: unknown;
  /** Present on catalogue snapshots, absent on metrics entries (taken from the stored row then). */
  hostCluster?: SolanaCluster;
}

export interface FigureAnomaly {
  providerReference: string;
  hostCluster: SolanaCluster;
  metric: "apy" | "tvl_usd";
  reason: "jump" | "ceiling";
  previous: number | null;
  current: number;
  /** current / previous, null when either side is zero (the absolute delta decided). */
  ratio: number | null;
}

/**
 * Pure diff of incoming figures against stored ones. References with no stored
 * row are new and exempt from the jump check; a null or unparseable figure on
 * either side is skipped rather than guessed at (a provider that stops
 * reporting a rate is the refresh's own documented behaviour, not an anomaly).
 */
export function detectFigureAnomalies(
  stored: readonly StoredStrategyFigures[],
  incoming: readonly IncomingStrategyFigures[]
): FigureAnomaly[] {
  const before = new Map(stored.map((row) => [row.providerReference, row]));
  const anomalies: FigureAnomaly[] = [];

  for (const next of incoming) {
    const prev = before.get(next.providerReference);
    const hostCluster = next.hostCluster ?? prev?.hostCluster;
    if (hostCluster === undefined) {
      // A metrics entry for a reference the catalogue does not hold: the
      // refresh no-ops on it and so does this.
      continue;
    }
    const base = { providerReference: next.providerReference, hostCluster };

    const apy = parseFigure(next.currentApy);
    if (apy !== null) {
      if (apy > EARN_FIGURE_BOUNDS.apyCeiling) {
        anomalies.push({
          ...base,
          metric: "apy",
          reason: "ceiling",
          previous: parseFigure(prev?.currentApy),
          current: apy,
          ratio: null,
        });
      }
      const prevApy = parseFigure(prev?.currentApy);
      if (prevApy !== null) {
        const jump = judgeJump(prevApy, apy, {
          ratio: EARN_FIGURE_BOUNDS.apyJumpRatio,
          minAbsoluteDelta: EARN_FIGURE_BOUNDS.apyMinAbsoluteDelta,
        });
        if (jump) {
          anomalies.push({
            ...base,
            metric: "apy",
            reason: "jump",
            previous: prevApy,
            current: apy,
            ratio: jump.ratio,
          });
        }
      }
    }

    const tvl = parseFigure(next.tvlUsd);
    const prevTvl = prev?.tvlUsd ?? null;
    if (tvl !== null && prevTvl !== null) {
      const jump = judgeJump(prevTvl, tvl, {
        ratio: EARN_FIGURE_BOUNDS.tvlJumpRatio,
        minAbsoluteDelta: EARN_FIGURE_BOUNDS.tvlMinAbsoluteDeltaUsd,
      });
      if (jump) {
        anomalies.push({
          ...base,
          metric: "tvl_usd",
          reason: "jump",
          previous: prevTvl,
          current: tvl,
          ratio: jump.ratio,
        });
      }
    }
  }

  return anomalies;
}

/**
 * Diff and report in one call, returning how many anomalies were emitted so
 * a pass can carry the count on its own summary line. Never throws: a
 * telemetry fault must not cost the pass its write.
 */
export function reportFigureAnomalies(args: {
  source: FigureAnomalySource;
  provider: string;
  environment: string;
  stored: readonly StoredStrategyFigures[];
  incoming: readonly IncomingStrategyFigures[];
}): number {
  const anomalies = detectFigureAnomalies(args.stored, args.incoming);
  for (const anomaly of anomalies) {
    logEvent("warn", {
      event: "sdp_api_earn_catalogue_figure_anomaly",
      source: args.source,
      provider: args.provider,
      environment: args.environment,
      provider_reference: anomaly.providerReference,
      host_cluster: anomaly.hostCluster,
      metric: anomaly.metric,
      reason: anomaly.reason,
      previous: anomaly.previous,
      current: anomaly.current,
      ratio: anomaly.ratio,
    });
  }
  return anomalies.length;
}

/**
 * A lane held `previousCount` rows in its scope and this pass reliably lists
 * none. Error-level: whichever way the lane resolves it, a shelf vanishing
 * between hourly passes is either a provider incident or a catalogue-side
 * regression, and both want a human within the hour.
 */
export function reportShelfDisappearance(args: {
  provider: string;
  environment: string;
  delistScope: string;
  previousCount: number;
  willDelist: boolean;
}): void {
  logEvent("error", {
    event: "sdp_api_earn_catalogue_shelf_disappeared",
    source: "catalogue_sync",
    provider: args.provider,
    environment: args.environment,
    delist_scope: args.delistScope,
    previous_count: args.previousCount,
    will_delist: args.willDelist,
  });
}

/**
 * A figure is a finite number or a non-empty numeric string, and nothing else.
 * `Number(...)` alone is too generous for provider-controlled input: `true`
 * reads as 1, `""` and `[]` as 0, and either would fabricate a collapse event
 * out of malformed data. Anything not shaped like a figure is "no figure".
 */
function parseFigure(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || !NUMERIC_STRING.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

const NUMERIC_STRING = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/**
 * A move counts as a jump when it clears BOTH the ratio bound and the absolute
 * floor. Either alone misfires: ratio alone flags 0.01% → 0.05%, absolute alone
 * flags every large vault's ordinary daily flow. With a zero on either side the
 * ratio is undefined, so the absolute floor decides on its own.
 */
function judgeJump(
  previous: number,
  current: number,
  bound: { ratio: number; minAbsoluteDelta: number }
): { ratio: number | null } | null {
  if (Math.abs(current - previous) < bound.minAbsoluteDelta) return null;
  if (previous <= 0 || current <= 0) return { ratio: null };
  const ratio = current / previous;
  if (ratio >= bound.ratio || ratio <= 1 / bound.ratio) return { ratio };
  return null;
}
