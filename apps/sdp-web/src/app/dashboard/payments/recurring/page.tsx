import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { isRecurringPaymentsDashboardEnabled } from "@/lib/recurring-payments-feature";
import { fetchCounterparties } from "../counterparty/counterparty-page.data";
import { fetchPaymentsWallets } from "../payments-page.data";
import { fetchRecurringPayments } from "./recurring-payments.data";
import { RecurringPaymentsWorkspace } from "./recurring-payments-workspace";

export const dynamic = "force-dynamic";

export default async function RecurringPaymentsPage() {
  if (!isRecurringPaymentsDashboardEnabled()) {
    notFound();
  }

  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  return withDashboardPageTrace(
    "dashboard.recurring-payments.page",
    async ({ trace, apiClient }) => {
      const [recurringPaymentsResult, walletsResult, counterpartiesResult] = await Promise.all([
        trace.step("fetch_recurring_payments", () => fetchRecurringPayments(apiClient.request)),
        trace.step("fetch_wallets", () =>
          fetchPaymentsWallets(apiClient.request, { includeBalances: true })
        ),
        trace.step("fetch_counterparties", () =>
          fetchCounterparties(apiClient.request, { pageSize: 100 })
        ),
      ]);

      trace.log({
        ok: recurringPaymentsResult.ok,
        recurringPaymentCount: recurringPaymentsResult.data.length,
        recurringPaymentTotal: recurringPaymentsResult.total,
        walletsOk: walletsResult.ok,
        walletCount: walletsResult.data?.length ?? 0,
        counterpartiesOk: counterpartiesResult.ok,
        counterpartyCount: counterpartiesResult.data.length,
      });

      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          <RecurringPaymentsWorkspace
            initialRecurringPayments={recurringPaymentsResult.data}
            initialTotal={recurringPaymentsResult.total}
            initialError={recurringPaymentsResult.error}
            wallets={(walletsResult.data ?? []).map((wallet) => ({
              walletId: wallet.walletId,
              label: wallet.label,
              publicKey: wallet.publicKey,
              balances: wallet.balances ?? [],
            }))}
            counterparties={counterpartiesResult.data.map((counterparty) => ({
              id: counterparty.id,
              displayName: counterparty.displayName,
            }))}
            lookupError={
              walletsResult.ok && counterpartiesResult.ok
                ? undefined
                : [
                    walletsResult.ok ? null : (walletsResult.error ?? "Unable to load wallets"),
                    counterpartiesResult.ok
                      ? null
                      : (counterpartiesResult.error ?? "Unable to load counterparties"),
                  ]
                    .filter(Boolean)
                    .join(" ")
            }
          />
        </div>
      );
    }
  );
}
