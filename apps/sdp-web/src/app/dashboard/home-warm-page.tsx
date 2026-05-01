"use client";

import { useMemo } from "react";
import { useDashboardWarmSnapshot } from "@/lib/use-dashboard-warm-snapshot";
import { HomeWorkspace } from "./home-workspace";
import { resolveTotalBalance } from "./payments/payments-overview.utils";

export function HomeWarmPage() {
  const { data: snapshot, isLoading } = useDashboardWarmSnapshot({ revalidate: false });
  const wallets = snapshot?.wallets.data ?? [];
  const aggregate = snapshot?.aggregateBalance.data ?? null;
  const totalBalance = useMemo(
    () => resolveTotalBalance(aggregate?.balances ?? []),
    [aggregate?.balances]
  );
  const totalBalanceError =
    snapshot?.aggregateBalance.status === "refreshing"
      ? null
      : (snapshot?.aggregateBalance.error ?? null);

  return (
    <HomeWorkspace
      totalBalance={totalBalance}
      totalBalanceError={totalBalanceError}
      wallets={wallets}
      isWarmSnapshotLoading={isLoading && !snapshot}
    />
  );
}
