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

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

import { rankedStrategies } from "./earn-deposit-model";
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
    hostCluster: "devnet",
    fundable: true,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...partial,
  };
}

function wallet(
  partial: Partial<Omit<CustodyWalletSummary, "custodyConfigId" | "custodyConnectionId">> = {}
): CustodyWalletSummary {
  return {
    id: "cw_1",
    custodyConfigId: "custody-config-1",
    walletId: "wallet_1",
    publicKey: "7M6bFdwsXQZX9MjoD4PDxQJb9FZbwdQh6VS8sK7F3WcQ",
    label: "Treasury Ops",
    purpose: null,
    status: "active",
    createdAt: TIMESTAMP,
    provider: "fireblocks",
    isRuntimeExecutionAllowed: true,
    ...partial,
  };
}

const CATALOGUE = [
  strategy({
    id: "Kamino Gauntlet USDC",
    currentApy: "0.061",
    underlyingSource: "kamino",
    provider: "kamino",
    hostCluster: "mainnet-beta",
    fundable: false,
  }),
  strategy({
    id: "Ground JTRSY USDC",
    currentApy: "0.104",
    sourceKind: "rwa",
    liquidityTerm: "delayed",
    redemptionDelayDays: 2,
  }),
];
const GROUND_STRATEGY = CATALOGUE[1];

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
    expect(html).toContain("DashboardEarn.deposit.walletAvailableToInvest");
    expect(html).toContain("1,250 USDC");
  });

  it("distinguishes an unavailable balance read from a confirmed zero", () => {
    const unavailable = renderToStaticMarkup(
      <WalletStep
        fireblocksEnabled
        hasError={false}
        isLoading={false}
        onSelect={() => {}}
        selectedWalletId={null}
        wallets={[wallet()]}
      />
    );
    const confirmedZero = renderToStaticMarkup(
      <WalletStep
        fireblocksEnabled
        hasError={false}
        isLoading={false}
        onSelect={() => {}}
        selectedWalletId={null}
        wallets={[wallet({ balances: [] })]}
      />
    );

    expect(unavailable).toContain(">—</span>");
    expect(unavailable).not.toContain("0 USDC");
    expect(confirmedZero).toContain("0 USDC");
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

describe("StrategyStep", () => {
  it("renders the full catalogue and marks an environment mismatch unavailable", () => {
    const html = renderToStaticMarkup(
      <StrategyStep
        hasError={false}
        isLoading={false}
        onSelect={() => {}}
        portfolioProvider="ground"
        selectedStrategyId={null}
        strategies={rankedStrategies(CATALOGUE)}
        tokens={["usdc"]}
      />
    );
    expect(html).toContain("<table");
    expect(html).toContain("<thead");
    expect(html).toContain("<tbody");
    expect(html.match(/name="earn-strategy"/g)).toHaveLength(2);
    expect(html).toContain("Kamino Gauntlet USDC");
    expect(html).toContain("Ground JTRSY USDC");
    expect(html).toContain("DashboardEarn.deposit.strategyEnvironmentOnly(Mainnet)");
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(html).toContain("10.4%");
    expect(html).toContain("DashboardEarn.liquidity.delayed(2)");
    expect(html).toContain("$40M");
    // Curator survives as metadata only — never as a selection step.
    expect(html).toContain("DashboardEarn.deposit.curatedBy(Gauntlet)");
    expect(html).not.toContain("DashboardEarn.deposit.filterAccess");
    expect(html).not.toContain("DashboardEarn.deposit.filterSort");
    // Single-stablecoin catalogue: no redundant column.
    expect(html).not.toContain("DashboardEarn.deposit.strategyStablecoinColumn");
  });

  it("renders no filter banner for the short catalogue", () => {
    const html = renderToStaticMarkup(
      <StrategyStep
        hasError={false}
        isLoading={false}
        onSelect={() => {}}
        portfolioProvider="ground"
        selectedStrategyId={null}
        strategies={rankedStrategies(CATALOGUE)}
        tokens={["usdc"]}
      />
    );
    expect(html).not.toContain("<select");
    expect(html).not.toContain("DashboardEarn.deposit.clearFilters");
  });

  it("shows a clear notice instead of a blank list", () => {
    const html = renderToStaticMarkup(
      <StrategyStep
        hasError={false}
        isLoading={false}
        onSelect={() => {}}
        portfolioProvider="ground"
        selectedStrategyId={null}
        strategies={[]}
        tokens={["usdc"]}
      />
    );
    expect(html).toContain("DashboardEarn.deposit.strategiesEmpty");
    expect(html).not.toContain("DashboardEarn.deposit.clearFilters");
  });

  /**
   * Overlap regressions. Neither renderer here does layout, so the rendered
   * classes are the only observable — and that is exactly where both bugs lived:
   * a class that silently never applied, and one that applied when it should not
   * have.
   */
  it("keeps a long provider name inside its own column", () => {
    const html = renderToStaticMarkup(
      <StrategyStep
        hasError={false}
        isLoading={false}
        onSelect={() => {}}
        portfolioProvider="ground"
        selectedStrategyId={null}
        strategies={[
          strategy({ id: "long", name: "Janus Henderson JTRSY tokenized by Centrifuge" }),
        ]}
        tokens={["usdc"]}
      />
    );

    // `TableCell` merges its own classes with a plain join (no tailwind-merge)
    // and `.whitespace-nowrap` is emitted last, so wrapping only takes effect
    // when it is declared on the span — where an own value beats an inherited
    // one. The clamp then bounds the row height instead of the column width.
    const nameClasses = /<span class="([^"]*)" id="earn-strategy-long-name"/.exec(html)?.[1] ?? "";
    expect(nameClasses).toContain("whitespace-normal");
    expect(nameClasses).toContain("line-clamp-2");
    expect(nameClasses).toContain("break-words");
    // The full name stays reachable on hover even when the clamp bites.
    expect(html).toContain('title="Janus Henderson JTRSY tokenized by Centrifuge"');
  });

  it("renders an unreported pool without inventing a number", () => {
    const html = renderToStaticMarkup(
      <StrategyStep
        hasError={false}
        isLoading={false}
        onSelect={() => {}}
        portfolioProvider="ground"
        selectedStrategyId={null}
        strategies={[strategy({ id: "no-pool", riskMetadata: {} })]}
        tokens={["usdc"]}
      />
    );
    expect(html).toContain('id="earn-strategy-no-pool-pool"');
    expect(html).toContain(">—</td>");
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
        strategy={GROUND_STRATEGY}
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
        strategy={GROUND_STRATEGY}
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
        strategy={GROUND_STRATEGY}
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
        strategy={GROUND_STRATEGY}
        submitError={null}
        wallet={wallet()}
      />
    );
    expect(html).toContain("DashboardEarn.overview.providerNotConfigured");
    expect(html).not.toContain("DashboardEarn.deposit.createTitle");
  });

  it("lets a long summary value wrap instead of running back over its label", () => {
    const html = renderToStaticMarkup(
      <ReviewStep
        onEditStrategy={() => {}}
        onEditWallet={() => {}}
        programExists={false}
        providerUnconfigured={false}
        strategy={strategy({ id: "long", name: "Janus Henderson JTRSY tokenized by Centrifuge" })}
        submitError={null}
        wallet={wallet()}
      />
    );

    expect(html).toContain("Janus Henderson JTRSY tokenized by Centrifuge");
    // A `shrink-0 whitespace-nowrap` value did not merely overflow the row:
    // `justify-between` distributes negative free space, so it slid back over
    // the label. The value now takes the slack (`ml-auto`) and wraps in it.
    expect(html).not.toContain("whitespace-nowrap");
    expect(html).toContain("ml-auto");
    expect(html).toContain("break-words");
  });

  it("surfaces a submit failure inline", () => {
    const html = renderToStaticMarkup(
      <ReviewStep
        onEditStrategy={() => {}}
        onEditWallet={() => {}}
        programExists={false}
        providerUnconfigured={false}
        strategy={GROUND_STRATEGY}
        submitError="Ground requires manual activation for this organization."
        wallet={wallet()}
      />
    );
    expect(html).toContain("requires manual activation");
    expect(html).toContain('role="alert"');
  });
});
