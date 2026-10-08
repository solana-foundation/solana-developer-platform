import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { withLegacyDesign } from "@/flags/new-design";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { PAYMENT_TRANSACTIONS_HREF } from "@/lib/payments-routes";
import { requestProjectHref } from "@/lib/sdp-api";
import { fetchCounterparty } from "../../counterparty/counterparty-page.data";
import { fetchIssuedTokensByMint } from "../../payments-page.data";
import { fetchTransactionDetail } from "../transaction-detail.data";
import { TransactionDetailWorkspace } from "../transaction-detail-workspace";

export const dynamic = "force-dynamic";

async function TransactionDetailRoute({ params }: { params: Promise<{ transactionId: string }> }) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const { transactionId } = await params;

  return withDashboardPageTrace(
    "dashboard.payments.transaction.detail.page",
    async ({ trace, apiClient }) => {
      const [detail, issuedTokensByMint] = await Promise.all([
        trace.step("fetch_transaction_detail", () =>
          fetchTransactionDetail(apiClient, transactionId)
        ),
        trace.step("fetch_issued_tokens", () => fetchIssuedTokensByMint(apiClient.request)),
      ]);
      // The ledger row carries the contact's id; its name comes from the contact itself, so an
      // older or archived contact still names the page. A missing contact keeps the id.
      const counterpartyId = detail.status === "found" ? detail.transaction.counterpartyId : null;
      const counterpartyName =
        counterpartyId === null
          ? null
          : await trace.step(
              "fetch_counterparty",
              async () =>
                (await fetchCounterparty(apiClient.request, counterpartyId))?.displayName ?? null
            );

      trace.log({ status: detail.status });

      if (detail.status === "not_found") {
        redirect(await requestProjectHref(PAYMENT_TRANSACTIONS_HREF));
      }

      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          <TransactionDetailWorkspace
            transaction={detail.status === "found" ? detail.transaction : null}
            transfer={detail.status === "found" ? detail.transfer : null}
            issuedTokensByMint={issuedTokensByMint}
            counterpartyName={counterpartyName}
            error={detail.status === "error" ? detail.error : undefined}
          />
        </div>
      );
    }
  );
}

/**
 * The previous design has no transaction page, and its list opens a transaction only from a row
 * click. It lands on that list searched for the id, which the ledger matches as a prefix, so the
 * transaction is the row to open.
 */
async function LegacyTransactionDetailRoute({
  params,
}: {
  params: Promise<{ transactionId: string }>;
}): Promise<never> {
  const { transactionId } = await params;
  redirect(
    await requestProjectHref(
      `${PAYMENT_TRANSACTIONS_HREF}?${new URLSearchParams({ search: transactionId })}`
    )
  );
}

export default withLegacyDesign(TransactionDetailRoute, LegacyTransactionDetailRoute, "activity");
