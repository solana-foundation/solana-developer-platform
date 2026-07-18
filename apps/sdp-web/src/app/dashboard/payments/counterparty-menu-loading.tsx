"use client";

import { useSearchParams } from "next/navigation";
import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import {
  CounterpartyDirectorySkeleton,
  PaymentRequestsPageSkeleton,
} from "./payments-route-skeletons";
import { PaymentsWorkspaceTabsSkeleton } from "./payments-workspace-tabs";

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

export function CounterpartyMenuLoading({
  overview,
  targetSearch,
}: {
  overview: CounterpartyMenuOverview;
  targetSearch?: string;
}) {
  const searchParams = useSearchParams();
  const activeSearchParams =
    targetSearch === undefined ? searchParams : new URLSearchParams(targetSearch);
  const isPlaygroundTab = activeSearchParams.get("tab") === "playground";
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <PaymentsWorkspaceTabsSkeleton />
      <div className="min-h-0 flex-1">
        {isPlaygroundTab ? (
          <CounterpartyPlaygroundLoading />
        ) : overview === "payment-requests" ? (
          <PaymentRequestsPageSkeleton />
        ) : (
          <CounterpartyDirectorySkeleton />
        )}
      </div>
    </div>
  );
}
