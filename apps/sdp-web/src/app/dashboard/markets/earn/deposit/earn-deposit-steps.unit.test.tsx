import type { CustodyWalletSummary, EarnStrategy } from "@sdp/types";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Translations resolve to their key so assertions read as the copy contract.
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

import { profileFilters, profileSummaries, visibleStrategies } from "./earn-deposit-model";
import { ProfileStep } from "./profile-step";
import { ReviewStep } from "./review-step";
import { StrategyStep } from "./strategy-step";
import { WalletStep } from "./wallet-step";

const TIMESTAMP = "2026-07-18T09:00:00.000Z";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function strategy(partial: Partial<EarnStrategy> & { id: string }): EarnStrategy {
  return {
    provider: "ground",
    providerReference: `${partial.id}-ref`,
    name: partial.id,
    sourceKind: "defi",
    depositMints: [USDC],
    apyType: "variable",
    currentApy: "0.061",
    liquidityTerm: "instant",
    riskMetadata: { tvlUsd: 40_000_000, curator: "gauntlet" },
    status: "active",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...partial,
  };
}

function wallet(partial: Partial<CustodyWalletSummary> = {}): CustodyWalletSummary {
  return {
    id: "cw_1",
    walletId: "wallet_1",
    publicKey: "7M6bFdwsXQZX9MjoD4PDxQJb9FZbwdQh6VS8sK7F3WcQ",
    label: "Treasury Ops",
    purpose: null,
    status: "active",
    createdAt: TIMESTAMP,
    provider: "fireblocks",
    ...partial,
  };
}

const CATALOGUE = [
  strategy({ id: "Kamino Gauntlet USDC", currentApy: "0.061", underlyingSource: "kamino" }),
  strategy({
    id: "Ground JTRSY USDC",
    currentApy: "0.104",
    sourceKind: "rwa",
    liquidityTerm: "delayed",
    redemptionDelayDays: 2,
  }),
];

describe("WalletStep", () => {
  it("renders a wallet row with its name first and address second", () => {
    const html = renderToStaticMarkup(
      <WalletStep
        fireblocksEnabled
        hasError={false}
        isLoading={false}
        onSelect={() => {}}
        selectedWalletId={null}
        wallets={[wallet()]}
      />
    );
    expect(html).toContain("Treasury Ops");
    expect(html).toContain("7M6bFd…7F3WcQ");
    // Addresses must never be monospaced in this module.
    expect(html).not.toContain("font-mono");
    expect(html).toContain('type="radio"');
  });

  it("names the wallet's stablecoin holdings when balances loaded", () => {
    const html = renderToStaticMarkup(
      <WalletStep
        fireblocksEnabled
        hasError={false}
        isLoading={false}
        onSelect={() => {}}
        selectedWalletId="wallet_1"
        wallets={[
          wallet({
            balances: [
              { token: "USDC", mint: USDC, amount: "1250000000", uiAmount: "1250", decimals: 6 },
            ],
          }),
        ]}
      />
    );
    expect(html).toContain("DashboardEarn.deposit.walletHolding(1250,USDC)");
  });

  it("offers the connect path when the org has no wallets", () => {
    const html = renderToStaticMarkup(
      <WalletStep
        fireblocksEnabled
        hasError={false}
        isLoading={false}
        onSelect={() => {}}
        selectedWalletId={null}
        wallets={[]}
      />
    );
    expect(html).toContain("DashboardEarn.deposit.walletsEmptyTitle");
    expect(html).toContain('href="/dashboard/wallets/setup?provider=fireblocks"');
  });

  it("routes to Wallets instead of a dead end when Fireblocks is not entitled", () => {
    const html = renderToStaticMarkup(
      <WalletStep
        fireblocksEnabled={false}
        hasError={false}
        isLoading={false}
        onSelect={() => {}}
        selectedWalletId={null}
        wallets={[wallet()]}
      />
    );
    expect(html).toContain("DashboardEarn.deposit.connectFireblocksLockedTitle");
    expect(html).toContain('href="/dashboard/wallets"');
    expect(html).not.toContain("provider=fireblocks");
  });
});

describe("ProfileStep", () => {
  it("states live catalogue figures and disclaims any risk rating", () => {
    const html = renderToStaticMarkup(
      <ProfileStep
        hasError={false}
        isLoading={false}
        onSelect={() => {}}
        selectedProfile="balanced"
        summaries={profileSummaries(CATALOGUE)}
      />
    );
    // Liquidity-first reaches only the instant 6.1% source; yield-first reaches 10.4%.
    expect(html).toContain("DashboardEarn.deposit.profileTopApyLabel");
    expect(html).toContain("6.1%");
    expect(html).toContain("10.4%");
    // The meta line carries count + the access constraint — the differentiator
    // when two profiles tie on top APY.
    expect(html).toContain(
      "DashboardEarn.deposit.profileMeta(1,DashboardEarn.deposit.profileLiquidityAccess)"
    );
    expect(html).toContain(
      "DashboardEarn.deposit.profileMeta(2,DashboardEarn.deposit.profileYieldAccess)"
    );
    expect(html).toContain("DashboardEarn.deposit.profileBasisBody");
  });

  it("states an empty profile as a dash and a zero count, never a fabricated rate", () => {
    const html = renderToStaticMarkup(
      <ProfileStep
        hasError={false}
        isLoading={false}
        onSelect={() => {}}
        selectedProfile={null}
        summaries={profileSummaries([
          strategy({ id: "slow", liquidityTerm: "delayed", redemptionDelayDays: 30 }),
        ])}
      />
    );
    expect(html).toContain("—");
    expect(html).toContain(
      "DashboardEarn.deposit.profileMeta(0,DashboardEarn.deposit.profileLiquidityAccess)"
    );
  });
});

describe("StrategyStep", () => {
  const filters = profileFilters("yield");

  it("renders each strategy with rate, access, pool and metadata", () => {
    const html = renderToStaticMarkup(
      <StrategyStep
        filters={filters}
        hasError={false}
        isLoading={false}
        onFiltersChange={() => {}}
        onReset={() => {}}
        onSelect={() => {}}
        selectedStrategyId={null}
        strategies={visibleStrategies(CATALOGUE, filters)}
        tokens={["usdc"]}
      />
    );
    expect(html).toContain("10.4%");
    // Access and pool share one quiet facts line.
    expect(html).toContain("DashboardEarn.liquidity.delayed(2)");
    expect(html).toContain("DashboardEarn.deposit.poolMeta($40M)");
    // Curator survives as metadata only — never as a selection step.
    expect(html).toContain("DashboardEarn.deposit.curatedBy(Gauntlet)");
    expect(html).toContain("DashboardEarn.deposit.resultCount(2)");
    // Single-stablecoin catalogue: no per-row token chip.
    expect(html).not.toContain(">USDC<");
  });

  it("hides the stablecoin filter when the catalogue has a single lane", () => {
    const html = renderToStaticMarkup(
      <StrategyStep
        filters={filters}
        hasError={false}
        isLoading={false}
        onFiltersChange={() => {}}
        onReset={() => {}}
        onSelect={() => {}}
        selectedStrategyId={null}
        strategies={visibleStrategies(CATALOGUE, filters)}
        tokens={["usdc"]}
      />
    );
    expect(html).not.toContain("DashboardEarn.deposit.filterTokenAny");
  });

  it("invites widening the filters instead of showing a blank list", () => {
    const html = renderToStaticMarkup(
      <StrategyStep
        filters={filters}
        hasError={false}
        isLoading={false}
        onFiltersChange={() => {}}
        onReset={() => {}}
        onSelect={() => {}}
        selectedStrategyId={null}
        strategies={[]}
        tokens={["usdc"]}
      />
    );
    expect(html).toContain("DashboardEarn.deposit.strategiesEmpty");
    expect(html).toContain("DashboardEarn.deposit.clearFilters");
  });

  it("renders an unreported pool without inventing a number", () => {
    const html = renderToStaticMarkup(
      <StrategyStep
        filters={filters}
        hasError={false}
        isLoading={false}
        onFiltersChange={() => {}}
        onReset={() => {}}
        onSelect={() => {}}
        selectedStrategyId={null}
        strategies={[strategy({ id: "no-pool", riskMetadata: {} })]}
        tokens={["usdc"]}
      />
    );
    // An unreported pool is omitted from the facts line, not placeholdered.
    expect(html).not.toContain("DashboardEarn.deposit.poolMeta");
    expect(html).not.toContain("$0");
  });
});

describe("ReviewStep", () => {
  it("names the funding wallet, the lane, and which lanes stay untouched", () => {
    const html = renderToStaticMarkup(
      <ReviewStep
        onEditStrategy={() => {}}
        onEditWallet={() => {}}
        programExists={false}
        providerUnconfigured={false}
        strategy={CATALOGUE[0]}
        submitError={null}
        wallet={wallet()}
      />
    );
    expect(html).toContain("Treasury Ops");
    expect(html).toContain("DashboardEarn.deposit.routingBody(USDC)");
    expect(html).toContain("DashboardEarn.deposit.createTitle");
  });

  it("hides the wallet section on a change-strategy run, which has no wallet step", () => {
    const html = renderToStaticMarkup(
      <ReviewStep
        onEditStrategy={() => {}}
        onEditWallet={() => {}}
        programExists
        providerUnconfigured={false}
        strategy={CATALOGUE[0]}
        submitError={null}
        wallet={undefined}
      />
    );
    expect(html).not.toContain("DashboardEarn.deposit.reviewWalletAddress");
    expect(html).not.toContain("DashboardEarn.deposit.walletUnnamed");
    expect(html).toContain("DashboardEarn.deposit.reviewStrategy");
  });

  it("switches to replace-strategy copy when a program already exists", () => {
    const html = renderToStaticMarkup(
      <ReviewStep
        onEditStrategy={() => {}}
        onEditWallet={() => {}}
        programExists
        providerUnconfigured={false}
        strategy={CATALOGUE[0]}
        submitError={null}
        wallet={wallet()}
      />
    );
    expect(html).toContain("DashboardEarn.deposit.updateTitle");
    expect(html).not.toContain("DashboardEarn.deposit.createTitle");
  });

  it("degrades to the quiet notice when the provider is unconfigured", () => {
    const html = renderToStaticMarkup(
      <ReviewStep
        onEditStrategy={() => {}}
        onEditWallet={() => {}}
        programExists={false}
        providerUnconfigured
        strategy={CATALOGUE[0]}
        submitError={null}
        wallet={wallet()}
      />
    );
    expect(html).toContain("DashboardEarn.overview.providerNotConfigured");
    expect(html).not.toContain("DashboardEarn.deposit.createTitle");
  });

  it("surfaces a submit failure inline", () => {
    const html = renderToStaticMarkup(
      <ReviewStep
        onEditStrategy={() => {}}
        onEditWallet={() => {}}
        programExists={false}
        providerUnconfigured={false}
        strategy={CATALOGUE[0]}
        submitError="Ground requires manual activation for this organization."
        wallet={wallet()}
      />
    );
    expect(html).toContain("requires manual activation");
    expect(html).toContain('role="alert"');
  });
});
