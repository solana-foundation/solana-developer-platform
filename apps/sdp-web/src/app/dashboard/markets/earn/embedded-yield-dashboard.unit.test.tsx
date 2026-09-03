// @vitest-environment jsdom

import type { EarnExternalWalletPosition, EarnExternalWalletPositionSummary } from "@sdp/types";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { EmbeddedYieldDashboard } from "./embedded-yield-dashboard";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const mocks = vi.hoisted(() => ({
  cluster: "devnet" as "devnet" | "mainnet-beta",
  summary: undefined as EarnExternalWalletPositionSummary | undefined,
  error: undefined as Error | undefined,
  isInitialLoading: false,
  fetchPositions: vi.fn<() => Promise<EarnExternalWalletPosition[]>>(),
}));

vi.mock("@/lib/use-solana-cluster", () => ({
  useSolanaCluster: () => mocks.cluster,
}));

vi.mock("./earn-program-data", () => ({
  fetchEarnExternalWalletPositions: mocks.fetchPositions,
  useEarnExternalWalletPositionSummary: () => ({
    summary: mocks.summary,
    error: mocks.error,
    isInitialLoading: mocks.isInitialLoading,
  }),
}));

function renderWithEnglish(children: ReactNode) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  mocks.summary = undefined;
  mocks.cluster = "devnet";
  mocks.error = undefined;
  mocks.isInitialLoading = false;
  mocks.fetchPositions.mockReset();
  vi.useRealTimers();
});

describe("EmbeddedYieldDashboard", () => {
  it("renders complete customer totals and the configuration entry point", () => {
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

    renderWithEnglish(
      <EmbeddedYieldDashboard configureHref="/dashboard/markets/embedded-yield/configure" />
    );

    expect(screen.getByRole("link", { name: "Set up Embedded Yield" }).getAttribute("href")).toBe(
      "/dashboard/markets/embedded-yield/configure"
    );
    expect(screen.getByText("USDC Core Yield")).toBeTruthy();
    expect(screen.getByText("1,250.42 USDC")).toBeTruthy();
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

    renderWithEnglish(
      <EmbeddedYieldDashboard configureHref="/dashboard/markets/embedded-yield/configure" />
    );

    expect(screen.getByText(/Live values are unavailable for 1 position/)).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(document.body.textContent).not.toContain("0 USDC");
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
    renderWithEnglish(
      <EmbeddedYieldDashboard configureHref="/dashboard/markets/embedded-yield/configure" />
    );

    expect(screen.getByText("Customer Portfolio")).toBeTruthy();
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("keeps the refresh status region mounted before an error occurs", () => {
    mocks.summary = {
      walletCount: 0,
      positionCount: 0,
      unavailablePositionCount: 0,
      totalsByToken: [],
      totalsByStrategy: [],
    };

    renderWithEnglish(
      <EmbeddedYieldDashboard configureHref="/dashboard/markets/embedded-yield/configure" />
    );

    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("shows the current two-step setup flow without the removed UI builder", () => {
    mocks.summary = {
      walletCount: 0,
      positionCount: 0,
      unavailablePositionCount: 0,
      totalsByToken: [],
      totalsByStrategy: [],
    };

    renderWithEnglish(
      <EmbeddedYieldDashboard configureHref="/dashboard/markets/embedded-yield/configure" />
    );

    const progress = screen.getByRole("list", { name: "Embedded Yield setup progress" });
    expect(within(progress).getAllByRole("listitem")).toHaveLength(2);
    expect(within(progress).getByText("Select a strategy")).toBeTruthy();
    expect(within(progress).getByText("Integrate the API")).toBeTruthy();
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

    renderWithEnglish(
      <EmbeddedYieldDashboard configureHref="/dashboard/markets/embedded-yield/configure" />
    );

    expect(screen.getByText("Choose a yield strategy to integrate")).toBeTruthy();
    expect(screen.getByText(/Showing the last complete portfolio/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Showing the last complete portfolio");
    expect(screen.queryByText("Customer portfolio unavailable")).toBeNull();
  });

  it("refreshes an open strategy wallet drawer without replacing settled content", async () => {
    vi.useFakeTimers();
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

    renderWithEnglish(
      <EmbeddedYieldDashboard configureHref="/dashboard/markets/embedded-yield/configure" />
    );
    fireEvent.click(screen.getByRole("row", { name: "View customer wallets for USDC Core Yield" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.fetchPositions).toHaveBeenCalledTimes(1);
    const drawer = screen.getByRole("dialog", { name: "USDC Core Yield" });
    expect(within(drawer).getByText("5.9 USDC")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(mocks.fetchPositions).toHaveBeenCalledTimes(2);
    expect(within(drawer).getByText("5.9 USDC")).toBeTruthy();
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

    renderWithEnglish(
      <EmbeddedYieldDashboard configureHref="/dashboard/markets/embedded-yield/configure" />
    );
    fireEvent.click(screen.getByRole("row", { name: "View customer wallets for USDC Core Yield" }));

    const explorerLink = await screen.findByRole("link", {
      name: "Open wallet in Solana Explorer",
    });
    expect(explorerLink.getAttribute("href")).toBe(
      "https://explorer.solana.com/address/11111111111111111111111111111111"
    );
  });
});
