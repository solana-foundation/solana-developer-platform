import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchIssuedTokensByMint } from "../payments-page.data";
import { fetchTransactionsPage } from "./transactions-page.data";
import { parseTransactionFilters } from "./transactions-query";
import { TransactionsWorkspace } from "./transactions-workspace";

interface TransactionsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TransactionsPage({ searchParams }: TransactionsPageProps) {
  const { userId, orgId } = await auth();
  if (!userId) redirect(await getAuthEntryPath());
  if (!orgId) redirect("/dashboard");

  const filters = parseTransactionFilters(await searchParams);
  const trace = createTimedTrace("dashboard.payments.transactions.page");
  const apiClient = await trace.step("create_sdp_api_client", () =>
    createSdpApiClient(trace.childContext("dashboard.payments.transactions.api"))
  );
  const [result, issuedTokensByMint] = await Promise.all([
    trace.step("fetch_transactions_page", () => fetchTransactionsPage(apiClient, filters)),
    trace.step("fetch_issued_tokens", () => fetchIssuedTokensByMint(apiClient.request)),
  ]);
  trace.log({ ok: true, resultCount: result.transactions.length });

  return (
    <TransactionsWorkspace
      initialFilters={filters}
      initialResult={result}
      issuedTokensByMint={issuedTokensByMint}
    />
  );
}
