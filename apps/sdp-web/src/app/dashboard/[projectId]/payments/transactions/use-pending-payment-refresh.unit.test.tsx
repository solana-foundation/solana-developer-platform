// @vitest-environment jsdom

import type { UnifiedTransaction } from "@sdp/types/unified-transactions";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { usePendingPaymentRefresh } from "./use-pending-payment-refresh";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const pending: Pick<UnifiedTransaction, "module" | "status"> = {
  module: "payments",
  status: "pending",
};

beforeEach(() => {
  vi.useFakeTimers();
  resetDashboardNavigation();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pending payment refresh", () => {
  it("refreshes a pending transfer until settlement, then stops", () => {
    const view = renderHook((transaction) => usePendingPaymentRefresh(transaction, "transfer"), {
      initialProps: pending,
    });
    act(() => vi.advanceTimersByTime(15_000));
    expect(dashboardRouter.refresh).toHaveBeenCalledOnce();

    view.rerender({ ...pending, status: "succeeded" });
    act(() => vi.advanceTimersByTime(30_000));
    expect(dashboardRouter.refresh).toHaveBeenCalledOnce();
  });

  it("keeps recovering a pending payment when its transfer details are unavailable", () => {
    renderHook(() => usePendingPaymentRefresh(pending, undefined));
    act(() => vi.advanceTimersByTime(15_000));
    expect(dashboardRouter.refresh).toHaveBeenCalledOnce();
  });

  it.each(["onramp", "offramp"] as const)(
    "leaves %s refreshes to the existing ramp poller",
    (type) => {
      renderHook(() => usePendingPaymentRefresh(pending, type));
      act(() => vi.advanceTimersByTime(30_000));
      expect(dashboardRouter.refresh).not.toHaveBeenCalled();
    }
  );

  it("does not refresh another module's pending transaction", () => {
    renderHook(() => usePendingPaymentRefresh({ ...pending, module: "issuance" }, undefined));
    act(() => vi.advanceTimersByTime(30_000));
    expect(dashboardRouter.refresh).not.toHaveBeenCalled();
  });

  it("pauses while hidden and stops after leaving the transaction page", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const view = renderHook(() => usePendingPaymentRefresh(pending, "transfer"));
    act(() => vi.advanceTimersByTime(15_000));
    expect(dashboardRouter.refresh).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    act(() => vi.advanceTimersByTime(15_000));
    expect(dashboardRouter.refresh).toHaveBeenCalledOnce();

    view.unmount();
    act(() => vi.advanceTimersByTime(30_000));
    expect(dashboardRouter.refresh).toHaveBeenCalledOnce();
  });
});
