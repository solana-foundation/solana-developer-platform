import { parseDvpTradesFilters } from "./dvp-trades-query";
import { DvpTradesWorkspace } from "./dvp-trades-workspace";

interface DvpTradesPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DvpTradesPage({ searchParams }: DvpTradesPageProps) {
  // `waiting` never rides the URL — it selects the inbound segment, which is client state — so it
  // reads as all.
  const { status, filters } = parseDvpTradesFilters((await searchParams) ?? {});
  return (
    <DvpTradesWorkspace
      filters={filters}
      searchQuery={filters.q === null ? "" : filters.q}
      statusFilter={status === "waiting" ? "all" : status}
    />
  );
}
