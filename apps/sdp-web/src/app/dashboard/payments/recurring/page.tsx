import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { isRecurringPaymentsDashboardEnabled } from "@/lib/recurring-payments-feature";
import { fetchCounterparty } from "../counterparty/counterparty-page.data";
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
      const [recurringPaymentsResult, walletsResult] = await Promise.all([
        trace.step("fetch_recurring_payments", () => fetchRecurringPayments(apiClient.request)),
        trace.step("fetch_wallets", () =>
          fetchPaymentsWallets(apiClient.request, { includeBalances: true })
        ),
      ]);
      const counterpartyIds = [
        ...new Set(recurringPaymentsResult.data.map((payment) => payment.counterpartyId)),
      ];
      const counterparties = await trace.step("fetch_recurring_payment_counterparties", () =>
        Promise.all(
          counterpartyIds.map((counterpartyId) =>
            fetchCounterparty(apiClient.request, counterpartyId)
          )
        )
      );
      const resolvedCounterparties = counterparties.filter((counterparty) => counterparty !== null);

      trace.log({
        ok: recurringPaymentsResult.ok,
        recurringPaymentCount: recurringPaymentsResult.data.length,
        recurringPaymentTotal: recurringPaymentsResult.total,
        walletsOk: walletsResult.ok,
        walletCount: walletsResult.data?.length ?? 0,
        counterpartiesOk: resolvedCounterparties.length === counterpartyIds.length,
        counterpartyCount: resolvedCounterparties.length,
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
            counterparties={resolvedCounterparties.map((counterparty) => ({
              id: counterparty.id,
              displayName: counterparty.displayName,
            }))}
            lookupError={
              walletsResult.ok && resolvedCounterparties.length === counterpartyIds.length
                ? undefined
                : [
                    walletsResult.ok ? null : (walletsResult.error ?? "Unable to load wallets"),
                    resolvedCounterparties.length === counterpartyIds.length
                      ? null
                      : "Unable to load some counterparties",
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
