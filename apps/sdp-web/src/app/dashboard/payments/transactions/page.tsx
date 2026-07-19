import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { TransactionsResultsSkeleton } from "../payments-route-skeletons";
import { fetchTransactionsPage } from "./transactions-page.data";
import { parseTransactionFilters } from "./transactions-query";
import { TransactionsResults } from "./transactions-results";
import { TransactionsWorkspace } from "./transactions-workspace";

interface TransactionsPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TransactionsPage({ searchParams }: TransactionsPageProps) {
  const { userId, orgId } = await auth();
  if (!userId) redirect(await getAuthEntryPath());
  if (!orgId) redirect("/dashboard");

  const filters = parseTransactionFilters((await searchParams) ?? {});
  const trace = createTimedTrace("dashboard.payments.transactions.page");
  const apiClientPromise = trace.step("create_sdp_api_client", () =>
    createSdpApiClient(trace.childContext("dashboard.payments.transactions.api"))
  );
  trace.log({ ok: true, phase: "page_chrome" });

  return (
    <TransactionsWorkspace filters={filters}>
      <Suspense key={JSON.stringify(filters)} fallback={<TransactionsResultsSkeleton />}>
        <TransactionsData apiClientPromise={apiClientPromise} filters={filters} />
      </Suspense>
    </TransactionsWorkspace>
  );
}

async function TransactionsData({
  apiClientPromise,
  filters,
}: {
  apiClientPromise: ReturnType<typeof createSdpApiClient>;
  filters: ReturnType<typeof parseTransactionFilters>;
}) {
  const trace = createTimedTrace("dashboard.payments.transactions.results");
  const { request } = await apiClientPromise;
  const result = await trace.step("fetch_transactions_page", () =>
    fetchTransactionsPage(request, filters)
  );
  trace.log({
    ok: !result.error,
    requestCount: 1,
    responseBytes: new TextEncoder().encode(JSON.stringify(result)).byteLength,
    page: result.page,
    pageSize: result.pageSize,
    resultCount: result.transfers.length,
    total: result.total,
  });
  return <TransactionsResults result={result} serverFilters={filters} />;
}
