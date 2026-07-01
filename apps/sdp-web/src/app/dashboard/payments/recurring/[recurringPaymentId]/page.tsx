import { auth } from "@clerk/nextjs/server";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { isRecurringPaymentsDashboardEnabled } from "@/lib/recurring-payments-feature";
import { fetchCounterparty } from "../../counterparty/counterparty-page.data";
import { formatDisplayAmount, shortenAddress } from "../../payments-overview.utils";
import { fetchPaymentsWallets } from "../../payments-page.data";
import { fetchRecurringPaymentById } from "../recurring-payments.data";
import { RecurringPaymentDetailWorkspace } from "../recurring-payments-workspace";

export const dynamic = "force-dynamic";

export default async function RecurringPaymentDetailRoute({
  params,
}: {
  params: Promise<{ recurringPaymentId: string }>;
}) {
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

  const { recurringPaymentId } = await params;

  return withDashboardPageTrace(
    "dashboard.recurring-payments.detail.page",
    async ({ trace, apiClient }) => {
      const [recurringPaymentResult, walletsResult] = await Promise.all([
        trace.step("fetch_recurring_payment", () =>
          fetchRecurringPaymentById(apiClient.request, recurringPaymentId)
        ),
        trace.step("fetch_wallets", () =>
          fetchPaymentsWallets(apiClient.request, { includeBalances: true })
        ),
      ]);

      trace.log({
        ok: recurringPaymentResult.ok,
        walletsOk: walletsResult.ok,
      });

      if (!recurringPaymentResult.data) {
        redirect("/dashboard/payments/recurring");
      }
      const recurringPayment = recurringPaymentResult.data;

      const wallets = (walletsResult.data ?? []).map((wallet) => ({
        walletId: wallet.walletId,
        label: wallet.label,
        publicKey: wallet.publicKey,
        balances: wallet.balances ?? [],
      }));
      const wallet =
        wallets.find((entry) => entry.walletId === recurringPayment.sourceWalletId) ?? null;
      const counterparty = await trace.step("fetch_recurring_payment_counterparty", () =>
        fetchCounterparty(apiClient.request, recurringPayment.counterpartyId)
      );
      const counterpartyLabel = counterparty?.displayName ?? "Counterparty unavailable";
      const knownToken = WELL_KNOWN_TOKEN_BY_MINT.get(recurringPayment.token);
      const tokenLabel =
        knownToken?.symbol ??
        wallet?.balances.find((entry) => entry.mint === recurringPayment.token)?.token ??
        shortenAddress(recurringPayment.token);

      return (
        <RecurringPaymentDetailWorkspace
          recurringPayment={recurringPayment}
          wallet={wallet}
          counterpartyLabel={counterpartyLabel}
          amountLabel={formatDisplayAmount(recurringPayment.amount, tokenLabel)}
          currencyLabel={tokenLabel}
        />
      );
    }
  );
}
