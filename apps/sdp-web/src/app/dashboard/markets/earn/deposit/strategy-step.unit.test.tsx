// @vitest-environment jsdom

import type { EarnStrategy } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { rankedStrategies } from "./earn-deposit-model";
import { StrategyStep } from "./strategy-step";

/**
 * The comparison table's ranking behaviour, driven through real clicks. The
 * ordering rules themselves are the model's (see earn-deposit-model.unit.test);
 * this covers the wiring the model cannot see — which header is clickable, what
 * `aria-sort` reports, and that the rendered row order actually follows.
 */

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
    currentApy: "0.05",
    liquidityTerm: "instant",
    status: "active",
    hostCluster: "devnet",
    fundable: true,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...partial,
  };
}

/** Deliberately not in either sorted order, and one row reports no pool. */
const CATALOGUE = [
  strategy({ id: "mid-pool", currentApy: "0.058", riskMetadata: { tvlUsd: 12_100_000 } }),
  strategy({ id: "no-pool", currentApy: "0.041" }),
  strategy({ id: "big-pool", currentApy: "0.051", riskMetadata: { tvlUsd: 22_000_000 } }),
];

function renderStep({
  onSelect = () => {},
  selectedStrategyId = null,
  strategies = CATALOGUE,
}: {
  onSelect?: (strategyId: string) => void;
  selectedStrategyId?: string | null;
  strategies?: readonly EarnStrategy[];
} = {}) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <StrategyStep
        hasError={false}
        isLoading={false}
        onSelect={onSelect}
        portfolioProvider="ground"
        selectedStrategyId={selectedStrategyId}
        strategies={rankedStrategies(strategies)}
        tokens={["usdc"]}
      />
    </I18nProvider>
  );
}

/** Rendered row order, read off the radios so it cannot drift from selection. */
function renderedOrder(): string[] {
  return screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value);
}

afterEach(cleanup);

describe("StrategyStep ranking", () => {
  it("opens on highest APY first, with that column marked descending", () => {
    renderStep();
    expect(renderedOrder()).toEqual(["mid-pool", "big-pool", "no-pool"]);
    expect(screen.getByRole("columnheader", { name: "APY" }).getAttribute("aria-sort")).toBe(
      "descending"
    );
    expect(screen.getByRole("columnheader", { name: "Pool size" }).getAttribute("aria-sort")).toBe(
      "none"
    );
  });

  it("ranks by pool size when that header is clicked, largest first", async () => {
    renderStep();
    await userEvent.click(screen.getByRole("button", { name: "Pool size" }));

    expect(renderedOrder()).toEqual(["big-pool", "mid-pool", "no-pool"]);
    expect(screen.getByRole("columnheader", { name: "Pool size" }).getAttribute("aria-sort")).toBe(
      "descending"
    );
    // Ranking moves to the clicked column; the previous one goes neutral.
    expect(screen.getByRole("columnheader", { name: "APY" }).getAttribute("aria-sort")).toBe(
      "none"
    );
  });

  it("flips direction on a second click, keeping the unreported pool last", async () => {
    renderStep();
    const poolHeader = screen.getByRole("button", { name: "Pool size" });
    await userEvent.click(poolHeader);
    await userEvent.click(poolHeader);

    expect(renderedOrder()).toEqual(["mid-pool", "big-pool", "no-pool"]);
    expect(screen.getByRole("columnheader", { name: "Pool size" }).getAttribute("aria-sort")).toBe(
      "ascending"
    );
  });

  it("ranks by lowest APY after clicking back onto the APY column", async () => {
    renderStep();
    await userEvent.click(screen.getByRole("button", { name: "Pool size" }));
    await userEvent.click(screen.getByRole("button", { name: "APY" }));
    expect(renderedOrder()).toEqual(["mid-pool", "big-pool", "no-pool"]);

    await userEvent.click(screen.getByRole("button", { name: "APY" }));
    expect(renderedOrder()).toEqual(["no-pool", "big-pool", "mid-pool"]);
    expect(screen.getByRole("columnheader", { name: "APY" }).getAttribute("aria-sort")).toBe(
      "ascending"
    );
  });

  it("does not offer the descriptive columns as sort controls", () => {
    renderStep();
    // Backing and Access are labels, not rankings — nothing to compare them by.
    expect(screen.queryByRole("button", { name: "Backing" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Access" })).toBeNull();
  });

  it("shows an environment-mismatched Kamino vault but does not select it", async () => {
    const onSelect = vi.fn();
    renderStep({
      onSelect,
      selectedStrategyId: "kamino-mainnet",
      strategies: [
        strategy({ id: "ground-devnet", name: "Ground Devnet USDC" }),
        strategy({
          id: "kamino-mainnet",
          name: "Kamino Mainnet USDC",
          provider: "kamino",
          hostCluster: "mainnet-beta",
          fundable: false,
        }),
      ],
    });

    const kaminoRadio = screen.getByRole("radio", { name: "Kamino Mainnet USDC" });
    expect((kaminoRadio as HTMLInputElement).disabled).toBe(true);
    expect((kaminoRadio as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Mainnet only")).toBeTruthy();
    expect(
      screen.getByText(
        "Strategies that cannot be funded from this project remain visible for comparison."
      )
    ).toBeTruthy();

    await userEvent.click(screen.getByText("Kamino Mainnet USDC"));
    expect(onSelect).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText("Ground Devnet USDC"));
    expect(onSelect).toHaveBeenCalledWith("ground-devnet");
  });
});
