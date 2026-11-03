// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { PayStatusWatch } from "./pay-status-watch";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const STATUS_URL = "https://api.test/pay/tok_1";

function respondWith(status: string) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderWatch(status: "awaiting_payment" | "paid") {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <PayStatusWatch statusUrl={STATUS_URL} status={status} />
    </SWRConfig>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetDashboardNavigation();
});

describe("PayStatusWatch", () => {
  it("redraws the page once an open link is paid, reading the API from the browser", async () => {
    const fetchMock = respondWith("paid");
    renderWatch("awaiting_payment");

    // The page's own read is the first; the watch waits its interval before reading again.
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchMock).toHaveBeenCalledWith(STATUS_URL, { cache: "no-store" });
    expect(dashboardRouter.refresh).toHaveBeenCalledOnce();
  });

  it("keeps reading, without redrawing, while the link stays open", async () => {
    const fetchMock = respondWith("awaiting_payment");
    renderWatch("awaiting_payment");

    await vi.advanceTimersByTimeAsync(20_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dashboardRouter.refresh).not.toHaveBeenCalled();
  });

  it("reads a link that is no longer open no more", async () => {
    const fetchMock = respondWith("paid");
    renderWatch("paid");

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
