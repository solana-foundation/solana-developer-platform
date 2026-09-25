import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { PAYMENT_TRANSACTION_OPEN_PARAM, transactionHref } from "@/lib/payments-routes";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchCounterparties } from "../counterparty/counterparty-page.data";
import { fetchIssuedTokensByMint, fetchPaymentsWallets } from "../payments-page.data";
import { fetchTransactionsPage } from "./transactions-page.data";
import { parseTransactionFilters } from "./transactions-query";
import { TransactionsWorkspace } from "./transactions-workspace";

interface TransactionsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// The filter menu offers, and the Contact column names, the first page of contacts at the
// API's maximum page size; a contact beyond it still filters by id from a deep link.
const CONTACT_OPTION_LIMIT = 100;

export default async function TransactionsPage({ searchParams }: TransactionsPageProps) {
  const { userId, orgId } = await auth();
  if (!userId) redirect(await getAuthEntryPath());
  if (!orgId) redirect("/dashboard");

  const params = await searchParams;
  const openId = params[PAYMENT_TRANSACTION_OPEN_PARAM];
  if (typeof openId === "string" && openId !== "") {
    // The ledger's old deep link to one transaction; it has its own page now.
    redirect(transactionHref(openId));
  }
  const filters = parseTransactionFilters(params);
  const trace = createTimedTrace("dashboard.payments.transactions.page");
  const apiClient = await trace.step("create_sdp_api_client", () =>
    createSdpApiClient(trace.childContext("dashboard.payments.transactions.api"))
  );
  const [result, issuedTokensByMint, wallets, counterparties] = await Promise.all([
    trace.step("fetch_transactions_page", () => fetchTransactionsPage(apiClient, filters)),
    trace.step("fetch_issued_tokens", () => fetchIssuedTokensByMint(apiClient.request)),
    trace.step("fetch_wallets", () => fetchPaymentsWallets(apiClient.request, { view: "summary" })),
    trace.step("fetch_counterparties", () =>
      fetchCounterparties(apiClient.request, { page: 1, pageSize: CONTACT_OPTION_LIMIT })
    ),
  ]);
  trace.log({ ok: true, resultCount: result.transactions.length });

  return (
    <TransactionsWorkspace
      initialFilters={filters}
      initialResult={result}
      issuedTokensByMint={issuedTokensByMint}
      wallets={(wallets.data ?? []).map((wallet) => ({
        id: wallet.id,
        label: wallet.label,
        publicKey: wallet.publicKey,
      }))}
      counterparties={counterparties.data.map((counterparty) => ({
        id: counterparty.id,
        name: counterparty.displayName,
      }))}
    />
  );
}
