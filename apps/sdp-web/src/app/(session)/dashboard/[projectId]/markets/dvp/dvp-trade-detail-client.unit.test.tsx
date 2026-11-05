// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardErrorResponse, readsOf, stubDashboardFetch } from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishDashboardReads } from "@/test/dashboard-reads";
import { DvpTradeDetailClient } from "./dvp-trade-detail-client";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/contexts/dashboard-workspace-context")>()),
  useDashboardWorkspace: () => ({
    sdpEnvironment: "sandbox",
    dashboardAccess: { capabilities: { canWrite: true } },
  }),
}));

const TRADE_PATH = "/api/dashboard/markets/dvp/trades/dvp_1";

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DvpTradeDetailClient", () => {
  it("shows the Project's not-found page for a trade the API says is not there", async () => {
    stubDashboardFetch(() => dashboardErrorResponse(404, "Trade not found."));

    render(<DvpTradeDetailClient tradeId="dvp_1" />, { wrapper: EnglishDashboardReads });

    expect(
      await screen.findByText("The page you're looking for doesn't exist or may have moved.")
    ).toBeTruthy();
    expect(screen.queryByText("This trade could not be loaded")).toBeNull();
  });

  it.each([
    ["a server error", () => dashboardErrorResponse(503, "Upstream down."), "Upstream down."],
    [
      "a 200 carrying no trade",
      () => Response.json({ data: {} }),
      "The request succeeded but carried no trade.",
    ],
  ])("reports %s as a failed read the reader can retry", async (_case, answer, detail) => {
    const fetchMock = stubDashboardFetch(answer);
    render(<DvpTradeDetailClient tradeId="dvp_1" />, { wrapper: EnglishDashboardReads });

    expect(await screen.findByText("This trade could not be loaded")).toBeTruthy();
    expect(screen.getByText(detail)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(readsOf(fetchMock, TRADE_PATH)).toBe(2));
  });
});
