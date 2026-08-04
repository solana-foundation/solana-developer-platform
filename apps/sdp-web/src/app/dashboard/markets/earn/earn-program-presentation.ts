"use client";

import { type EarnStrategy, earnCuratorLabel } from "@sdp/types";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { formatApy, tokenSymbol } from "./earn-format";

/**
 * Shared curator-program presentation helpers for every Earn surface
 * (overview, deposit wizard, and future program views). All helpers are pure
 * over live `EarnStrategy` catalogue rows — callers fetch the rows from the
 * strategies BFF and pass them in; nothing here holds module-level data.
 */

/** Group id for strategies whose catalogue row carries no curator. */
export const UNKNOWN_CURATOR_ID = "unknown";

/**
 * Risk tiers the dashboard knows how to describe. `riskMetadata.riskTier` is
 * an open string per ADR 0002, so unknown tiers simply don't map to copy.
 */
export const EARN_RISK_TIERS = ["conservative", "balanced", "enhanced"] as const;
export type EarnRiskTier = (typeof EARN_RISK_TIERS)[number];

export function strategyRiskTier(strategy: EarnStrategy): EarnRiskTier | undefined {
  const tier = strategy.riskMetadata?.riskTier;
  return EARN_RISK_TIERS.includes(tier as EarnRiskTier) ? (tier as EarnRiskTier) : undefined;
}

/** Curator id from the synced catalogue row, or the unknown-curator group. */
export function strategyCurator(strategy: EarnStrategy): string {
  const curator = strategy.riskMetadata?.curator;
  return typeof curator === "string" && curator.trim() !== "" ? curator : UNKNOWN_CURATOR_ID;
}

/** TVL in USD when the catalogue sync recorded one for the strategy. */
export function strategyTvlUsd(strategy: EarnStrategy): number | undefined {
  const tvlUsd = strategy.riskMetadata?.tvlUsd;
  return typeof tvlUsd === "number" && Number.isFinite(tvlUsd) ? tvlUsd : undefined;
}

export interface EarnCuratorProgram {
  id: string;
  strategies: readonly EarnStrategy[];
}

/** Group live strategies by curator in first catalogue appearance order. */
export function buildCuratorPrograms(
  strategies: readonly EarnStrategy[]
): readonly EarnCuratorProgram[] {
  const byCurator = new Map<string, EarnStrategy[]>();
  for (const strategy of strategies) {
    const curatorId = strategyCurator(strategy);
    const group = byCurator.get(curatorId);
    if (group) {
      group.push(strategy);
    } else {
      byCurator.set(curatorId, [strategy]);
    }
  }
  return [...byCurator].map(([id, curatorStrategies]) => ({ id, strategies: curatorStrategies }));
}

const KNOWN_CURATOR_PROFILE_IDS = new Set(["steakhouse", "gauntlet", "sentora"]);

export type CuratorProfileField = "headline" | "description" | "bestFor" | "risk" | "liquidity";

/** i18n key for a curator's profile copy, falling back to the default profile. */
export function curatorProfileKey(curatorId: string, field: CuratorProfileField): MessageKey {
  const profileId = KNOWN_CURATOR_PROFILE_IDS.has(curatorId) ? curatorId : "default";
  return `DashboardEarn.setup.curatorProfiles.${profileId}.${field}` as MessageKey;
}

/** Up-to-two-letter monogram for curator avatars. */
export function curatorMonogram(curatorId: string): string {
  const words = earnCuratorLabel(curatorId).split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/** Formatted min–max APY across a program's strategies, or "—" when unknown. */
export function curatorApyRange(
  program: Pick<EarnCuratorProgram, "strategies"> | undefined
): string {
  if (!program || program.strategies.length === 0) return "—";
  const apys = program.strategies
    .map((strategy) => Number(strategy.currentApy))
    .filter((apy) => Number.isFinite(apy));
  if (apys.length === 0) return "—";
  const minimum = Math.min(...apys);
  const maximum = Math.max(...apys);
  if (minimum === maximum) return formatApy(String(minimum));
  return `${formatApy(String(minimum))}–${formatApy(String(maximum))}`;
}

/** Unique funding-asset symbols across a program's strategies. */
export function programAssets(strategies: readonly EarnStrategy[]): string[] {
  return [
    ...new Set(
      strategies.flatMap((strategy) => strategy.depositMints.map((mint) => tokenSymbol(mint)))
    ),
  ];
}

/** Human liquidity term for a strategy (Instant or T+n). */
export function useLiquidityLabel() {
  const t = useTranslations();
  return (strategy: EarnStrategy): string => {
    if (strategy.liquidityTerm === "instant") {
      return t("DashboardEarn.liquidity.instant");
    }
    return t("DashboardEarn.liquidity.delayed", { days: strategy.redemptionDelayDays ?? 1 });
  };
}
