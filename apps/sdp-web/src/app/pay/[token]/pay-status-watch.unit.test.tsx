// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { PayStatusWatch } from "./pay-status-watch";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const STATUS_URL = "https://api.test/pay/tok_1";

const PAY_URL = "solana:https://api.test/pay/tok_1/tx";

function respondWith(status: string, solanaPayUrl: string | null) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () => new Response(JSON.stringify({ status, solanaPayUrl }), { status: 200 })
    );
}

function renderWatch(status: "awaiting_payment" | "paid", payable: boolean) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <PayStatusWatch statusUrl={STATUS_URL} status={status} payable={payable} />
    </SWRConfig>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetDashboardNavigation();
});

describe("PayStatusWatch", () => {
  it("redraws the page once an open link is paid, reading the API from the browser", async () => {
    const fetchMock = respondWith("paid", PAY_URL);
    renderWatch("awaiting_payment", true);

    // The page's own read is the first; the watch waits its interval before reading again.
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchMock).toHaveBeenCalledWith(STATUS_URL, { cache: "no-store" });
    expect(dashboardRouter.refresh).toHaveBeenCalledOnce();
  });

  it("keeps reading, without redrawing, while the link stays open", async () => {
    const fetchMock = respondWith("awaiting_payment", PAY_URL);
    renderWatch("awaiting_payment", true);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dashboardRouter.refresh).not.toHaveBeenCalled();
  });

  it("redraws an open link once the API stops offering a way to pay it (HOO-2009)", async () => {
    respondWith("awaiting_payment", null);
    renderWatch("awaiting_payment", true);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(dashboardRouter.refresh).toHaveBeenCalledOnce();
  });

  it("redraws an unavailable link once the API offers a way to pay it again", async () => {
    respondWith("awaiting_payment", PAY_URL);
    renderWatch("awaiting_payment", false);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(dashboardRouter.refresh).toHaveBeenCalledOnce();
  });

  it("reads a link that is no longer open no more", async () => {
    const fetchMock = respondWith("paid", PAY_URL);
    renderWatch("paid", true);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
