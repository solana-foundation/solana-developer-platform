"use client";

import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import {
  CounterpartyDirectorySkeleton,
  PaymentRequestsPageSkeleton,
} from "./payments-route-skeletons";

type CounterpartyMenuOverview = "counterparty-directory" | "payment-requests";

export function CounterpartyPlaygroundLoading() {
  return (
    <div
      className="h-full min-h-0 w-full"
      data-loading-layout="counterparty-playground"
      aria-busy="true"
    >
      <ApiPlaygroundShellSkeleton />
    </div>
  );
}

export function CounterpartyMenuLoading({ overview }: { overview: CounterpartyMenuOverview }) {
  const { counterpartyTab } = useDashboardWorkspace();

  if (counterpartyTab === "playground") {
    return <CounterpartyPlaygroundLoading />;
  }

  return overview === "payment-requests" ? (
    <PaymentRequestsPageSkeleton />
  ) : (
    <CounterpartyDirectorySkeleton />
  );
}
