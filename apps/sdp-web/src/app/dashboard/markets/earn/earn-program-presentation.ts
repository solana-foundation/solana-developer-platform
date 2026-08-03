"use client";

import { earnCuratorLabel } from "@sdp/types";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { buildCuratorPrograms, type CuratorProgram } from "./deposit/earn-setup-model";
import {
  formatApy,
  MOCK_EARN_STRATEGIES,
  type MockEarnStrategy,
  tokenSymbol,
} from "./earn-mock-data";

/**
 * Shared curator-program presentation helpers for every Earn surface
 * (overview, deposit wizard, and future program views). Keep formatting and
 * profile-copy lookups here so the surfaces can't drift apart.
 */

/** The mocked curator catalogue every Earn surface renders from. */
export const CURATOR_PROGRAMS = buildCuratorPrograms(MOCK_EARN_STRATEGIES);

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
export function curatorApyRange(program: CuratorProgram | undefined): string {
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
export function programAssets(strategies: readonly MockEarnStrategy[]): string[] {
  return [
    ...new Set(
      strategies.flatMap((strategy) => strategy.depositMints.map((mint) => tokenSymbol(mint)))
    ),
  ];
}

/** Human liquidity term for a strategy (Instant, T+n, or the mixed split). */
export function useLiquidityLabel() {
  const t = useTranslations();
  return (strategy: MockEarnStrategy): string => {
    if (strategy.liquidityTerm === "instant") {
      return t("DashboardEarn.liquidity.instant");
    }
    const days = strategy.redemptionDelayDays ?? 1;
    if (strategy.intradayFraction) {
      return t("DashboardEarn.liquidity.mixed", {
        pct: Math.round(strategy.intradayFraction * 100),
        days,
      });
    }
    return t("DashboardEarn.liquidity.delayed", { days });
  };
}
