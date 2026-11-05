// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishDashboardReads } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { HoldingsWorkspace } from "./holdings-workspace";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/components/token-mark", () => ({ TokenMark: () => null }));

function aggregate(): Response {
  return dashboardDataResponse(200, {
    aggregate: {
      walletCount: 2,
      balances: [
        { token: "USDC", mint: "mint_test_usdc", amount: "5000000", uiAmount: "5", decimals: 6 },
        { token: "PYUSD", mint: "mint_test_pyusd", amount: "2000000", uiAmount: "2", decimals: 6 },
      ],
    },
  });
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HoldingsWorkspace", () => {
  it("shows a skeleton, then every holding in the wallet aggregate", async () => {
    const fetchMock = stubDashboardFetch(aggregate);

    const { container } = render(<HoldingsWorkspace />, { wrapper: EnglishDashboardReads });

    expect(container.querySelector('[data-loading-layout="token-holdings"]')).not.toBeNull();
    expect(await screen.findByText("2 tokens")).toBeTruthy();
    expect(screen.getByText("USDC")).toBeTruthy();
    expect(screen.getByText("PYUSD")).toBeTruthy();
    expect(sentDashboardReads(fetchMock)).toEqual([
      { path: "/api/dashboard/wallets/aggregate", projectId: SANDBOX_PROJECT.id, demo: null },
    ]);
  });

  it("says holdings are unavailable when the aggregate fails, and reads it again on retry", async () => {
    const fetchMock = stubDashboardFetch(() =>
      fetchMock.mock.calls.length === 1
        ? dashboardErrorResponse(503, "upstream unavailable")
        : aggregate()
    );
    const user = userEvent.setup();
    render(<HoldingsWorkspace />, { wrapper: EnglishDashboardReads });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Holdings are unavailable right now."
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("2 tokens")).toBeTruthy();
  });
});
