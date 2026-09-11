"use client";

import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useMarketsSandbox } from "../markets-sandbox-store";
import { matchesAddressQuery } from "./dvp-trade";
import type { DvpTradesFilters } from "./dvp-trades.data";
import type { StatusFilter } from "./dvp-trades-query";
import { DvpTradesWorkspace } from "./dvp-trades-workspace";

export function DvpSandboxTradesPage({
  filters,
  searchQuery,
  statusFilter,
}: {
  filters: DvpTradesFilters;
  searchQuery: string;
  statusFilter: Exclude<StatusFilter, "waiting">;
}) {
  const { selectedProjectId } = useDashboardWorkspace();
  const { state } = useMarketsSandbox(selectedProjectId);
  const needle = filters.q?.trim().toLowerCase() ?? "";
  const trades = state.dvpTrades.filter((trade) => {
    if (filters.statuses && !filters.statuses.includes(trade.status)) return false;
    if (!needle) return true;
    return [
      trade.id,
      trade.refString,
      trade.legs.a.symbol,
      trade.legs.b.symbol,
      trade.legs.a.mint,
      trade.legs.b.mint,
      trade.legs.a.party.address,
      trade.legs.b.party.address,
    ]
      .filter(Boolean)
      .some((value) => matchesAddressQuery(String(value), needle));
  });

  return (
    <DvpTradesWorkspace
      error={null}
      inbound={[]}
      searchQuery={searchQuery}
      statusFilter={statusFilter}
      trades={trades}
    />
  );
}
