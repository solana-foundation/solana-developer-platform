import type { EarnStrategy } from "@sdp/types";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnProgramState } from "./earn-program-data";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@/components/dashboard-navigation-link", () => ({
  DashboardNavigationLink: ({ children, ...props }: ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));

// The workspace reads live data exclusively through these hooks, so the tests
// drive them directly instead of stubbing fetch + SWR plumbing.
const data = vi.hoisted(() => ({
  program: {
    state: undefined as EarnProgramState | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    refresh: () => {},
  },
  strategies: {
    strategies: undefined as EarnStrategy[] | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
  },
}));

vi.mock("./earn-program-data", () => ({
  useEarnProgram: () => data.program,
  useEarnStrategies: () => data.strategies,
}));

import { EarnWorkspace } from "./earn-workspace";

const TIMESTAMP = "2026-07-18T09:00:00.000Z";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function strategy(partial: {
  id: string;
  providerReference: string;
  name: string;
  curator?: string;
  riskTier?: string;
  currentApy?: string;
}): EarnStrategy {
  return {
    id: partial.id,
    provider: "ground",
    providerReference: partial.providerReference,
    name: partial.name,
    sourceKind: "defi",
    depositMints: [USDC],
    apyType: "variable",
    currentApy: partial.currentApy ?? "0.05",
    liquidityTerm: "instant",
    riskMetadata: {
      ...(partial.curator ? { curator: partial.curator } : {}),
      ...(partial.riskTier ? { riskTier: partial.riskTier } : {}),
      tvlUsd: 12_000_000,
    },
    status: "active",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

const CATALOGUE: EarnStrategy[] = [
  strategy({
    id: "earn_strategy_1",
    providerReference: "morpho-gauntlet-usdc",
    name: "Morpho Gauntlet USDC",
    curator: "gauntlet",
    riskTier: "balanced",
    currentApy: "0.062",
  }),
  strategy({
    id: "earn_strategy_2",
    providerReference: "morpho-steakhouse-usdc",
    name: "Morpho Steakhouse USDC",
    curator: "steakhouse",
    riskTier: "conservative",
    currentApy: "0.045",
  }),
  strategy({
    id: "earn_strategy_3",
    providerReference: "syrup-usdc",
    name: "Syrup USDC",
    curator: "sentora",
    riskTier: "enhanced",
    currentApy: "0.084",
  }),
];

beforeEach(() => {
  data.program.state = undefined;
  data.program.error = undefined;
  data.program.isLoading = false;
  data.strategies.strategies = CATALOGUE;
  data.strategies.error = undefined;
  data.strategies.isLoading = false;
});

describe("EarnWorkspace with no program yet", () => {
  beforeEach(() => {
    data.program.state = { kind: "none" };
  });

  it("renders the positions empty state and deposit entry", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.positionsTitle");
    expect(html).toContain("DashboardEarn.overview.positionsEmpty");
    expect(html).toContain('href="/dashboard/markets/earn/deposit"');
  });

  it("renders one onboarding card per live curator with its start link", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    for (const [id, label] of [
      ["steakhouse", "Steakhouse Financial"],
      ["gauntlet", "Gauntlet"],
      ["sentora", "Sentora"],
    ] as const) {
      expect(html).toContain(label);
      expect(html).toContain(`href="/dashboard/markets/earn/deposit?curator=${id}"`);
    }
  });

  it("shows the program decision hierarchy: APY lead, fit, risk, liquidity, assets", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.indicativeApyRange");
    expect(html).toContain("DashboardEarn.overview.bestFor");
    expect(html).toContain("DashboardEarn.overview.riskRange");
    expect(html).toContain("DashboardEarn.overview.liquidityRange");
    expect(html).toContain("DashboardEarn.overview.fundingAssets");
  });

  it("keeps underlying holdings available behind each program drawer", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.underlyingHoldings");
    expect(html).toContain("sdp-collapse");
  });
});

describe("EarnWorkspace with an active program", () => {
  beforeEach(() => {
    data.program.state = {
      kind: "active",
      program: {
        provider: "ground",
        label: "Treasury earn",
        createdAt: TIMESTAMP,
        wallet: {
          providerWalletRef: "wallet-ref-1",
          status: "ready",
          solanaDepositAddress: "7M6bFdwsXQZX9MjoD4PDxQJb9FZbwdQh6VS8sK7F3WcQ",
          balance: {
            totalUsd: "125000.50",
            withdrawableUsd: "120000.00",
            reservedUsd: "5000.50",
            earnedUsd: "1250.75",
          },
          positions: [
            {
              kind: "yield_source",
              label: "Morpho Gauntlet USDC",
              valueUsd: "100000.00",
              pct: 80,
              yieldSourceId: "morpho-gauntlet-usdc",
              token: "usdc",
            },
            {
              kind: "yield_source",
              label: "Morpho Steakhouse USDC",
              valueUsd: "20000.50",
              pct: 16,
              yieldSourceId: "morpho-steakhouse-usdc",
              token: "usdc",
            },
            { kind: "cash", label: "Cash", valueUsd: "5000.00", pct: 4 },
          ],
          allocations: {
            usdc: [
              { yieldSourceId: "morpho-gauntlet-usdc", weightBps: 8000 },
              { yieldSourceId: "morpho-steakhouse-usdc", weightBps: 2000 },
            ],
          },
        },
      },
    };
  });

  it("renders the live balance stat strip", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.totalBalance");
    expect(html).toContain("DashboardEarn.overview.totalEarned");
    expect(html).toContain("DashboardEarn.overview.withdrawableBalance");
    expect(html).toContain("$125,000.50");
    expect(html).toContain("$1,250.75");
  });

  it("groups yield-source positions by curator and cash separately", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("Gauntlet");
    expect(html).toContain("Steakhouse Financial");
    expect(html).toContain("DashboardEarn.overview.cashGroupTitle");
    expect(html).toContain("DashboardEarn.overview.curatorManaged");
  });

  it("offers the portfolio-level withdraw action and hides the curator hero", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.withdraw");
    expect(html).not.toContain("DashboardEarn.overview.curatorsTitle");
    expect(html).not.toContain('href="/dashboard/markets/earn/deposit?curator=');
  });
});

describe("EarnWorkspace when the provider is not configured", () => {
  beforeEach(() => {
    data.program.state = { kind: "unconfigured" };
  });

  it("renders a quiet notice and keeps the curator hero from the live catalogue", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.providerNotConfigured");
    expect(html).toContain("DashboardEarn.overview.curatorsTitle");
    expect(html).toContain("Gauntlet");
  });
});

describe("EarnWorkspace when the program read fails", () => {
  it("renders an inline error with a retry affordance instead of crashing", () => {
    data.program.error = new Error("boom");
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.programLoadError");
    expect(html).toContain("Shared.SharedComponents.retry");
  });
});
