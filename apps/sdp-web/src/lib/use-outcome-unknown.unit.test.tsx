// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import useSWR, { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isCounterpartyReadKey,
  paymentsQueryKeys,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { SANDBOX_PROJECT } from "@/test/projects";
import type { DashboardKeyScope } from "./dashboard-request-key";
import { type OutcomeUnknownLists, useOutcomeUnknownRefresh } from "./use-outcome-unknown";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const SCOPE: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "live" };

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
      useSWR(paymentsQueryKeys.allCounterparties(SCOPE), counterparties);
      useSWR(paymentsQueryKeys.recentTransferBatches(SCOPE, { pageSize: 5 }), unrelated);
      return useOutcomeUnknownRefresh(lists);
    },
    { wrapper }
  );
  return { hook, counterparties, unrelated };
}

describe("useOutcomeUnknownRefresh", () => {
  it("revalidates only the action's own lists, and refreshes the page", async () => {
    const { hook, counterparties, unrelated } = renderLists(isCounterpartyReadKey);
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
