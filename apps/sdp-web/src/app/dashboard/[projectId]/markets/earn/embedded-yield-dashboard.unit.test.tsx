// @vitest-environment jsdom

import type {
  EarnExternalWalletPosition,
  EarnExternalWalletPositionSummary,
  EarnStrategy,
} from "@sdp/types/earn";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnglishTestI18n } from "@/app/dashboard/[projectId]/markets/test-i18n";
import { EmbeddedYieldDashboard } from "./embedded-yield-dashboard";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const mocks = vi.hoisted(() => ({
  cluster: "devnet" as "devnet" | "mainnet-beta",
  summary: undefined as EarnExternalWalletPositionSummary | undefined,
  error: undefined as Error | undefined,
  isInitialLoading: false,
  strategies: [] as EarnStrategy[],
  fetchPositions: vi.fn<() => Promise<EarnExternalWalletPosition[]>>(),
  summaryOptions: vi.fn<(options?: { detailsVisible?: boolean }) => void>(),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
// A strategy's wallets slide open through HeightReveal, which measures itself with a
// ResizeObserver jsdom does not ship.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  }
);
vi.mock("@/lib/use-solana-cluster", () => ({
  useSolanaCluster: () => mocks.cluster,
}));

vi.mock("./earn-program-data", () => ({
  fetchEarnExternalWalletPositions: mocks.fetchPositions,
  useEarnExternalWalletPositionSummary: (options?: { detailsVisible?: boolean }) => {
    mocks.summaryOptions(options);
    return {
      summary: mocks.summary,
      error: mocks.error,
      isInitialLoading: mocks.isInitialLoading,
    };
  },
  useEarnStrategies: () => ({ strategies: mocks.strategies }),
}));

function strategyFixture(overrides: Partial<EarnStrategy> = {}): EarnStrategy {
  return {
    id: "strategy_1",
    provider: "kamino",
    providerReference: "vault_1",
    name: "USDC Core Yield",
    sourceKind: "defi",
    depositMints: [USDC],
    shareMint: "share_mint",
    apyType: "variable",
    liquidityTerm: "instant",
    status: "active",
    depositSlippage: null,
    withdrawalSlippage: null,
    hostCluster: "devnet",
    fundable: true,
    feeSponsored: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function positionFixture(
  overrides: Partial<EarnExternalWalletPosition> = {}
): EarnExternalWalletPosition {
  return {
    id: "position_1",
    ownerAddress: "11111111111111111111111111111111",
    provider: "kamino",
    providerReference: "vault_1",
    label: "USDC Core Yield",
    tokenMint: USDC,
    shareMint: "share_mint",
    createdAt: "2026-09-05T00:00:00.000Z",
    closedAt: null,
    shares: "5.9",
    withdrawableShares: "5.9",
    tokenValue: "5.9",
    ...overrides,
  };
}

function renderDashboard() {
  return render(
    <EnglishTestI18n>
      <EmbeddedYieldDashboard configureHref="/dashboard/markets/embedded-yield/configure" />
    </EnglishTestI18n>
  );
}

/** The hero figure under the summary's "Live value" label. */
function liveValueFigure(): string | undefined {
  const label = screen.getByRole("heading", { name: /^Live value/ });
  return label.nextElementSibling?.textContent ?? undefined;
}

/** A stat-line count, read beside the words that name it. */
function summaryCount(words: string): string | undefined {
  return screen.getByText(words).previousElementSibling?.textContent ?? undefined;
}

afterEach(() => {
  cleanup();
  mocks.summary = undefined;
  mocks.cluster = "devnet";
  mocks.error = undefined;
  mocks.isInitialLoading = false;
  mocks.strategies = [];
  mocks.fetchPositions.mockReset();
  mocks.summaryOptions.mockReset();
  vi.useRealTimers();
});

describe("EmbeddedYieldDashboard", () => {
  it("leads with the portfolio's live value and counts, then each strategy's total", () => {
    mocks.strategies = [strategyFixture()];
    mocks.summary = {
      walletCount: 3,
      positionCount: 4,
      unavailablePositionCount: 0,
      totalsByToken: [
        {
          tokenMint: USDC,
          walletCount: 3,
          positionCount: 4,
          unavailablePositionCount: 0,
          tokenValue: "1250.42",
        },
      ],
      totalsByStrategy: [
        {
          provider: "kamino",
          providerReference: "vault_1",
          label: "USDC Core Yield",
          ownerAddresses: ["11111111111111111111111111111111"],
          walletCount: 3,
          positionCount: 4,
          totalsByToken: [
            {
              tokenMint: USDC,
              walletCount: 3,
              positionCount: 4,
              unavailablePositionCount: 0,
              tokenValue: "1250.42",
            },
          ],
        },
      ],
    };

    renderDashboard();

    expect(liveValueFigure()).toBe("$1,250.42");
    expect(summaryCount("customer wallets")).toBe("3");
    expect(summaryCount("live positions")).toBe("4");
    expect(summaryCount("asset earning")).toBe("1");
    const strategyRow = screen.getByRole("row", {
      name: "View customer wallets for USDC Core Yield",
    });
    expect(within(strategyRow).getByText("USDC Core Yield")).toBeTruthy();
    expect(within(strategyRow).getByText("$1,250.42")).toBeTruthy();
    expect(within(strategyRow).getByText("Kamino · USDC · Instant")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("surfaces delayed liquidity with its T+N timing", () => {
    mocks.strategies = [strategyFixture({ liquidityTerm: "delayed", redemptionDelayDays: 3 })];
    mocks.summary = {
      walletCount: 1,
      positionCount: 1,
      unavailablePositionCount: 0,
      totalsByToken: [],
      totalsByStrategy: [
        {
          provider: "kamino",
          providerReference: "vault_1",
          label: "USDC Core Yield",
          ownerAddresses: ["11111111111111111111111111111111"],
          positions: [
            {
              id: "position_1",
              ownerAddress: "11111111111111111111111111111111",
              provider: "kamino",
              providerReference: "vault_1",
              label: "USDC Core Yield",
              tokenMint: USDC,
              shareMint: "share_mint",
              createdAt: "2026-09-02T00:00:00.000Z",
              closedAt: null,
              shares: "5.9",
              withdrawableShares: "5.9",
              tokenValue: "5.9",
            },
          ],
          walletCount: 1,
          positionCount: 1,
          totalsByToken: [
            {
              tokenMint: USDC,
              walletCount: 1,
              positionCount: 1,
              unavailablePositionCount: 0,
              tokenValue: "5.9",
            },
          ],
        },
      ],
    };

    renderDashboard();

    const strategyRow = screen.getByRole("row", {
      name: "View customer wallets for USDC Core Yield",
    });
    expect(within(strategyRow).getByText("Kamino · USDC · T+3 days")).toBeTruthy();
    expect(screen.queryByText("Pending")).toBeNull();

    fireEvent.click(strategyRow);
    const details = screen.getByRole("region", { name: "USDC Core Yield" });
    // The wallets under the row do not restate the strategy's own terms.
    expect(within(details).queryByText(/T\+3 days/)).toBeNull();
    expect(within(details).queryByText("Pending")).toBeNull();
  });

  it("does not describe fully withdrawable shares as locked when the provider retains a past timestamp", () => {
    mocks.summary = {
      walletCount: 1,
      positionCount: 1,
      unavailablePositionCount: 0,
      totalsByToken: [],
      totalsByStrategy: [
        {
          provider: "veda",
          providerReference: "vault_1",
          label: "Veda USDC",
          ownerAddresses: ["11111111111111111111111111111111"],
          positions: [
            positionFixture({
              provider: "veda",
              label: "Veda USDC",
              withdrawableShares: "5.9",
              unlockTimestamp: "1756684800",
            }),
          ],
          walletCount: 1,
          positionCount: 1,
          totalsByToken: [],
        },
      ],
    };

    renderDashboard();
    fireEvent.click(screen.getByRole("row", { name: "View customer wallets for Veda USDC" }));

    const details = screen.getByRole("region", { name: "Veda USDC" });
    expect(within(details).getByText("5.9")).toBeTruthy();
    expect(within(details).queryByText(/Locked shares unlock/)).toBeNull();
  });

  it("does not crash or render a lock date for an out-of-range provider timestamp", () => {
    mocks.summary = {
      walletCount: 1,
      positionCount: 1,
      unavailablePositionCount: 0,
      totalsByToken: [],
      totalsByStrategy: [
        {
          provider: "veda",
          providerReference: "vault_1",
          label: "Veda USDC",
          ownerAddresses: ["11111111111111111111111111111111"],
          positions: [
            positionFixture({
              provider: "veda",
              label: "Veda USDC",
              withdrawableShares: "0",
              unlockTimestamp: "99999999999999999999",
            }),
          ],
          walletCount: 1,
          positionCount: 1,
          totalsByToken: [],
        },
      ],
    };

    renderDashboard();
    fireEvent.click(screen.getByRole("row", { name: "View customer wallets for Veda USDC" }));

    const details = screen.getByRole("region", { name: "Veda USDC" });
    expect(within(details).getByText("0")).toBeTruthy();
    expect(within(details).queryByText(/Locked shares unlock/)).toBeNull();
  });

  it("treats an absent withdrawable share read as unavailable, not locked", () => {
    // The type contract says an absent read is a FAILED read, never zero —
    // coercing it would show an unlock date the data never claimed.
    mocks.summary = {
      walletCount: 1,
      positionCount: 1,
      unavailablePositionCount: 0,
      totalsByToken: [],
      totalsByStrategy: [
        {
          provider: "veda",
          providerReference: "vault_1",
          label: "Veda USDC",
          ownerAddresses: ["11111111111111111111111111111111"],
          positions: [
            positionFixture({
              provider: "veda",
              label: "Veda USDC",
              shares: "5.9",
              withdrawableShares: undefined,
              unlockTimestamp: "1756684800",
            }),
          ],
          walletCount: 1,
          positionCount: 1,
          totalsByToken: [],
        },
      ],
    };

    renderDashboard();
    fireEvent.click(screen.getByRole("row", { name: "View customer wallets for Veda USDC" }));

    const details = screen.getByRole("region", { name: "Veda USDC" });
    expect(within(details).queryByText(/Locked shares unlock/)).toBeNull();
  });

  it("withholds a strategy total when its live value is unavailable", () => {
    mocks.summary = {
      walletCount: 1,
      positionCount: 1,
      unavailablePositionCount: 1,
      totalsByToken: [
        { tokenMint: USDC, walletCount: 1, positionCount: 1, unavailablePositionCount: 1 },
      ],
      totalsByStrategy: [
        {
          provider: "kamino",
          providerReference: "vault_1",
          label: "USDC Core Yield",
          ownerAddresses: ["11111111111111111111111111111111"],
          walletCount: 1,
          positionCount: 1,
          totalsByToken: [
            { tokenMint: USDC, walletCount: 1, positionCount: 1, unavailablePositionCount: 1 },
          ],
        },
      ],
    };

    renderDashboard();

    expect(screen.getByText(/Live values are unavailable for 1 position/)).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    // The hero withholds the sum too, and says why behind its (i).
    expect(liveValueFigure()).toBe("—");
    expect(
      screen.getByRole("button", {
        name: "Withheld until every position's live value is read, so it never shows as partial.",
      })
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("$0.00");
  });

  it("renders settled portfolio data without the initial skeleton", () => {
    mocks.summary = {
      walletCount: 3,
      positionCount: 4,
      unavailablePositionCount: 0,
      totalsByToken: [
        {
          tokenMint: USDC,
          walletCount: 3,
          positionCount: 4,
          unavailablePositionCount: 0,
          tokenValue: "1250.42",
        },
      ],
      totalsByStrategy: [],
    };
    renderDashboard();

    expect(document.querySelector("[aria-busy='true']")).toBeNull();
    expect(liveValueFigure()).toBe("$1,250.42");
    expect(screen.getByRole("heading", { name: "Portfolio by strategy" })).toBeTruthy();
  });

  it("withholds the live value when an asset is not a dollar stablecoin", () => {
    mocks.summary = {
      walletCount: 2,
      positionCount: 2,
      unavailablePositionCount: 0,
      totalsByToken: [
        {
          tokenMint: USDC,
          walletCount: 1,
          positionCount: 1,
          unavailablePositionCount: 0,
          tokenValue: "10",
        },
        {
          tokenMint: SOL_MINT,
          walletCount: 1,
          positionCount: 1,
          unavailablePositionCount: 0,
          tokenValue: "5",
        },
      ],
      totalsByStrategy: [],
    };

    renderDashboard();

    // Dollars and SOL do not add, so there is no single figure, and no wrong one.
    expect(liveValueFigure()).toBe("—");
    expect(
      screen.getByRole("button", {
        name: "Some assets aren't dollar stablecoins, so no single total is shown.",
      })
    ).toBeTruthy();
    expect(summaryCount("assets earning")).toBe("2");
  });

  it("words each count for one and for several", () => {
    mocks.summary = {
      walletCount: 1,
      positionCount: 2,
      unavailablePositionCount: 0,
      totalsByToken: [
        {
          tokenMint: USDC,
          walletCount: 1,
          positionCount: 2,
          unavailablePositionCount: 0,
          tokenValue: "7.5",
        },
      ],
      totalsByStrategy: [],
    };

    renderDashboard();

    expect(summaryCount("customer wallet")).toBe("1");
    expect(summaryCount("live positions")).toBe("2");
    expect(summaryCount("asset earning")).toBe("1");
    expect(liveValueFigure()).toBe("$7.50");
  });

  it("keeps the refresh status region mounted before an error occurs", () => {
    mocks.summary = {
      walletCount: 0,
      positionCount: 0,
      unavailablePositionCount: 0,
      totalsByToken: [],
      totalsByStrategy: [],
    };

    renderDashboard();

    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("offers one direct integration action without a setup flow", () => {
    mocks.summary = {
      walletCount: 0,
      positionCount: 0,
      unavailablePositionCount: 0,
      totalsByToken: [],
      totalsByStrategy: [],
    };

    renderDashboard();

    expect(screen.queryByRole("list", { name: "Embedded Yield integration path" })).toBeNull();
    expect(screen.getByRole("link", { name: "Integrate" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/markets/embedded-yield/configure"
    );
    // The empty state's action is the page's own, so the header hides its copy.
    expect(document.querySelector("[data-hides-page-action]")).toBeTruthy();
    // Zero positions is the empty state alone: no zero hero or empty counts.
    expect(screen.queryByRole("heading", { name: /^Live value/ })).toBeNull();
    expect(screen.queryByText("Preview UI")).toBeNull();
  });

  it("keeps the last complete portfolio visible when a background refresh fails", () => {
    mocks.summary = {
      walletCount: 3,
      positionCount: 0,
      unavailablePositionCount: 0,
      totalsByToken: [],
      totalsByStrategy: [],
    };
    mocks.error = new Error("refresh failed");

    renderDashboard();

    expect(screen.getByText("Your customer portfolio will show here")).toBeTruthy();
    expect(screen.getByText(/Showing the last complete portfolio/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Showing the last complete portfolio");
    expect(screen.queryByText("Customer portfolio unavailable")).toBeNull();
  });

  it("renders more wallets than the chain-read quota from one summary request", () => {
    const positions: EarnExternalWalletPosition[] = Array.from({ length: 31 }, (_, index) => ({
      id: `position_${index + 1}`,
      ownerAddress: `customer_wallet_${String(index + 1).padStart(2, "0")}`,
      provider: "kamino",
      providerReference: "vault_1",
      label: "USDC Core Yield",
      tokenMint: USDC,
      shareMint: "share_mint",
      createdAt: "2026-09-02T00:00:00.000Z",
      closedAt: null,
      shares: "1",
      withdrawableShares: "1",
      tokenValue: "1",
    }));
    mocks.summary = {
      walletCount: positions.length,
      positionCount: positions.length,
      unavailablePositionCount: 0,
      totalsByToken: [],
      totalsByStrategy: [
        {
          provider: "kamino",
          providerReference: "vault_1",
          label: "USDC Core Yield",
          ownerAddresses: positions.map((position) => position.ownerAddress),
          positions,
          walletCount: positions.length,
          positionCount: positions.length,
          totalsByToken: [
            {
              tokenMint: USDC,
              walletCount: positions.length,
              positionCount: positions.length,
              unavailablePositionCount: 0,
              tokenValue: String(positions.length),
            },
          ],
        },
      ],
    };
    renderDashboard();
    expect(mocks.summaryOptions).toHaveBeenLastCalledWith({ detailsVisible: false });
    fireEvent.click(screen.getByRole("row", { name: "View customer wallets for USDC Core Yield" }));
    expect(mocks.summaryOptions).toHaveBeenLastCalledWith({ detailsVisible: true });

    const details = screen.getByRole("region", { name: "USDC Core Yield" });
    expect(screen.getByText("September 2, 2026")).toBeTruthy();
    expect(within(details).getAllByRole("article")).toHaveLength(positions.length);
    expect(within(details).getAllByText("$1.00")).toHaveLength(positions.length);
    expect(mocks.fetchPositions).not.toHaveBeenCalled();
  });

  it("opens wallet addresses on the active project cluster", async () => {
    mocks.cluster = "mainnet-beta";
    mocks.summary = {
      walletCount: 1,
      positionCount: 1,
      unavailablePositionCount: 0,
      totalsByToken: [],
      totalsByStrategy: [
        {
          provider: "kamino",
          providerReference: "vault_1",
          label: "USDC Core Yield",
          ownerAddresses: ["11111111111111111111111111111111"],
          positions: [
            {
              id: "position_1",
              ownerAddress: "11111111111111111111111111111111",
              provider: "kamino",
              providerReference: "vault_1",
              label: "USDC Core Yield",
              tokenMint: USDC,
              shareMint: "share_mint",
              createdAt: "2026-09-02T00:00:00.000Z",
              closedAt: null,
              shares: "5.9",
              withdrawableShares: "5.9",
              tokenValue: "5.9",
            },
          ],
          walletCount: 1,
          positionCount: 1,
          totalsByToken: [
            {
              tokenMint: USDC,
              walletCount: 1,
              positionCount: 1,
              unavailablePositionCount: 0,
              tokenValue: "5.9",
            },
          ],
        },
      ],
    };
    mocks.fetchPositions.mockResolvedValue([
      {
        id: "position_1",
        ownerAddress: "11111111111111111111111111111111",
        provider: "kamino",
        providerReference: "vault_1",
        label: "USDC Core Yield",
        tokenMint: USDC,
        shareMint: "share_mint",
        createdAt: "2026-09-02T00:00:00.000Z",
        closedAt: null,
        shares: "5.9",
        withdrawableShares: "5.9",
        tokenValue: "5.9",
      },
    ]);

    renderDashboard();
    fireEvent.click(screen.getByRole("row", { name: "View customer wallets for USDC Core Yield" }));

    const explorerLink = await screen.findByRole("link", {
      name: "Open wallet in Solana Explorer",
    });
    expect(explorerLink.getAttribute("href")).toBe(
      "https://explorer.solana.com/address/11111111111111111111111111111111"
    );
  });
});
