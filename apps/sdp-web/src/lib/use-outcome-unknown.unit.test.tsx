// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import useSWR, { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { paymentsQueryKeys } from "@/app/dashboard/[projectId]/payments/payments-query-key";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { type OutcomeUnknownLists, useOutcomeUnknownRefresh } from "./use-outcome-unknown";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  resetDashboardNavigation();
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

function renderLists(lists: OutcomeUnknownLists) {
  const counterparties = vi.fn(async () => ["counterparty"]);
  const unrelated = vi.fn(async () => ["transfer"]);
  const hook = renderHook(
    () => {
      useSWR(paymentsQueryKeys.actionCounterparties(), counterparties);
      useSWR(paymentsQueryKeys.transactions({ query: "" }), unrelated);
      return useOutcomeUnknownRefresh(lists);
    },
    { wrapper }
  );
  return { hook, counterparties, unrelated };
}

describe("useOutcomeUnknownRefresh", () => {
  it("revalidates only the action's own lists, and refreshes the page", async () => {
    const { hook, counterparties, unrelated } = renderLists(
      paymentsQueryKeys.isCounterpartyListKey
    );
    await waitFor(() => expect(unrelated).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(counterparties).toHaveBeenCalledTimes(1));

    act(() => hook.result.current());

    await waitFor(() => expect(counterparties).toHaveBeenCalledTimes(2));
    expect(unrelated).toHaveBeenCalledTimes(1);
    expect(dashboardRouter.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes only the page when every list is server-rendered", async () => {
    const { hook, counterparties, unrelated } = renderLists(null);
    await waitFor(() => expect(counterparties).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(unrelated).toHaveBeenCalledTimes(1));

    act(() => hook.result.current());

    expect(dashboardRouter.refresh).toHaveBeenCalledTimes(1);
    expect(counterparties).toHaveBeenCalledTimes(1);
    expect(unrelated).toHaveBeenCalledTimes(1);
  });
});
