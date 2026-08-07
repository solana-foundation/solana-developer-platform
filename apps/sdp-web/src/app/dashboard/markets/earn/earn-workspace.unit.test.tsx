import type { EarnStrategy } from "@sdp/types";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnProgramState } from "./earn-program-data";

// Values-aware identity translations, so assertions can pin interpolations
// (e.g. the trimmed share "programShare(80)").
vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) =>
    values ? `${key}(${Object.values(values).join(",")})` : key,
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
  // The workspace also reads the provider pin, so the hero counts exactly what
  // the deposit flow will offer rather than every synced row.
  EARN_PORTFOLIO_PROVIDER: "ground",
}));

import { EarnWorkspace } from "./earn-workspace";

const TIMESTAMP = "2026-07-18T09:00:00.000Z";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function strategy(partial: {
  id: string;
  providerReference: string;
  name: string;
  currentApy?: string;
  liquidityTerm?: EarnStrategy["liquidityTerm"];
  redemptionDelayDays?: number;
  underlyingSource?: string;
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
    liquidityTerm: partial.liquidityTerm ?? "instant",
    ...(partial.redemptionDelayDays === undefined
      ? {}
      : { redemptionDelayDays: partial.redemptionDelayDays }),
    ...(partial.underlyingSource === undefined
      ? {}
      : { underlyingSource: partial.underlyingSource }),
    riskMetadata: { tvlUsd: 12_000_000 },
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
    currentApy: "0.062",
    underlyingSource: "morpho",
  }),
  strategy({
    id: "earn_strategy_2",
    providerReference: "morpho-steakhouse-usdc",
    name: "Morpho Steakhouse USDC",
    currentApy: "0.045",
  }),
  strategy({
    id: "earn_strategy_3",
    providerReference: "ground-jaaa-usdc-vault",
    name: "Ground JAAA USDC",
    currentApy: "0.084",
    liquidityTerm: "delayed",
    redemptionDelayDays: 2,
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

describe("EarnWorkspace while the program is still loading", () => {
  it("shows the skeleton and never flashes the onboarding hero", () => {
    // state stays undefined (in flight). Rendering the hero here flashed
    // onboarding at program holders for a beat, then yanked it away.
    data.program.isLoading = true;
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).not.toContain("DashboardEarn.overview.startTitle");
    expect(html).not.toContain("DashboardEarn.overview.startAction");
    expect(html).toContain("aria-busy");
  });
});

describe("EarnWorkspace with no program yet", () => {
  beforeEach(() => {
    data.program.state = { kind: "none" };
  });

  it("renders the empty program state and a single deposit entry point", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.programTitle");
    expect(html).toContain("DashboardEarn.overview.programEmpty");
    expect(html).toContain('href="/dashboard/markets/earn/deposit"');
  });

  it("leads the hero with live catalogue facts rather than curator cards", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.startTitle");
    expect(html).toContain("DashboardEarn.overview.startStatStrategies");
    expect(html).toContain("DashboardEarn.overview.startStatTopApy");
    expect(html).toContain("DashboardEarn.overview.startStatAccess");
    // Three active strategies, best rate 8.4%, and at least one instant source.
    expect(html).toContain(">3<");
    expect(html).toContain("8.4%");
    expect(html).toContain("DashboardEarn.liquidity.instant");
  });

  it("never routes through a curator, the removed first step", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).not.toContain("curator");
    expect(html).not.toContain("Gauntlet");
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
        yield: { currentApy: "0.058", earnedUsd: "1250.75", positions: [] },
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
            { kind: "cash", label: "Cash (USDC)", valueUsd: "5000.00", pct: 4, token: "usdc" },
          ],
          allocations: {
            usdc: [{ yieldSourceId: "morpho-gauntlet-usdc", weightBps: 10_000 }],
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
    expect(html).toContain("5.8%");
  });

  it("lists holdings flat and deployed-first, with no curator grouping", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.holdingsTitle");
    const gauntlet = html.indexOf("Morpho Gauntlet USDC");
    const steakhouse = html.indexOf("Morpho Steakhouse USDC");
    const cash = html.indexOf("Cash (USDC)");
    expect(gauntlet).toBeGreaterThan(-1);
    expect(steakhouse).toBeGreaterThan(gauntlet);
    // Cash is not deployed, so it sorts last regardless of value.
    expect(cash).toBeGreaterThan(steakhouse);
  });

  it("renders the provider's position label verbatim so no chain name is rebuilt", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("Cash (USDC)");
  });

  it("explains what each cash slice is waiting for, from the target allocations", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    // The USDC lane targets a yield source, so its cash deploys on rebalance.
    expect(html).toContain("DashboardEarn.overview.cashDeploys");
  });

  it("hides zero-value residual cash buckets but keeps zero-value strategy rows", () => {
    // Ground keeps reporting a drained lane's cash bucket at $0 (e.g. the
    // Sepolia USDT lane once emptied) — residue, not a holding. A $0 strategy
    // slice stays: it carries the forward allocation story.
    const program = data.program.state?.kind === "active" ? data.program.state.program : undefined;
    program?.wallet.positions.push(
      { kind: "cash", label: "Cash (USDT)", valueUsd: "0.000000", token: "usdt" },
      { kind: "bridge", label: "In transit (USDC)", valueUsd: "0.000000", token: "usdc" },
      {
        kind: "yield_source",
        label: "Ground JAAA USDC",
        valueUsd: "0.000000",
        pct: 0,
        yieldSourceId: "ground-jaaa-usdc-vault",
        token: "usdc",
      }
    );
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).not.toContain("Cash (USDT)");
    expect(html).not.toContain("In transit (USDC)");
    expect(html).toContain("Ground JAAA USDC");
    // Nonzero cash still renders — value is never hidden, only $0 residue.
    expect(html).toContain("Cash (USDC)");
  });

  it("shows a trimmed share only where value sits behind it", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.programShare(80)");
    expect(html).not.toContain("programShare(80.0)");
  });

  it("keeps the deposit address one copy away on the dashboard", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.depositAddressLabel");
    expect(html).toContain("7M6bFd…7F3WcQ");
  });

  it("offers the two managing verbs and keeps deposit as the address row", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.withdraw");
    expect(html).toContain("DashboardEarn.overview.changeStrategy");
    // Depositing is the address row, not a wizard — nothing here says deposit
    // except the row itself.
    expect(html).toContain("DashboardEarn.overview.depositAddressLabel");
    expect(html).not.toContain("DashboardEarn.overview.startTitle");
  });
});

describe("EarnWorkspace when the provider is not configured", () => {
  beforeEach(() => {
    data.program.state = { kind: "unconfigured" };
  });

  it("renders a quiet notice and keeps the catalogue-backed hero", () => {
    const html = renderToStaticMarkup(<EarnWorkspace />);
    expect(html).toContain("DashboardEarn.overview.providerNotConfigured");
    expect(html).toContain("DashboardEarn.overview.startTitle");
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
