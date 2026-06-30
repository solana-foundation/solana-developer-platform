import { auth } from "@clerk/nextjs/server";
import type { CounterpartyAccount, ListCounterpartyAccountsResponse } from "@sdp/types";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { isRecurringPaymentsDashboardEnabled } from "@/lib/recurring-payments-feature";
import type { SdpApiClient } from "@/lib/sdp-api";
import { fetchCounterparty } from "../../counterparty/counterparty-page.data";
import { formatDisplayAmount, shortenAddress } from "../../payments-overview.utils";
import { fetchPaymentsWallets } from "../../payments-page.data";
import { fetchRecurringPaymentById } from "../recurring-payments.data";
import { RecurringPaymentDetailWorkspace } from "../recurring-payments-workspace";

export const dynamic = "force-dynamic";

const COUNTERPARTY_ACCOUNTS_PAGE_SIZE = 100;

async function fetchAllCounterpartyWalletAccounts(
  request: SdpApiClient["request"],
  counterpartyId: string
): Promise<CounterpartyAccount[]> {
  const encodedCounterpartyId = encodeURIComponent(counterpartyId);
  const accounts: CounterpartyAccount[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;

  while (accounts.length < total) {
    const response = await request(
      `/v1/counterparties/${encodedCounterpartyId}/accounts?page=${page}&pageSize=${COUNTERPARTY_ACCOUNTS_PAGE_SIZE}&accountKind=crypto_wallet`
    );
    if (!response.ok) {
      return [];
    }

    const json = (await response.json()) as { data?: ListCounterpartyAccountsResponse };
    const data = json.data;
    if (!data) {
      return accounts;
    }

    accounts.push(...data.accounts);
    total = data.total;
    if (data.accounts.length < data.pageSize) {
      break;
    }
    page += 1;
  }

  return accounts;
}

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

      const wallets = walletsResult.data ?? [];
      const wallet =
        wallets.find((entry) => entry.walletId === recurringPayment.sourceWalletId) ?? null;
      const counterparty = await trace.step("fetch_recurring_payment_counterparty", () =>
        fetchCounterparty(apiClient.request, recurringPayment.counterpartyId)
      );
      const counterpartyLabel = counterparty?.displayName ?? "Counterparty unavailable";
      const counterpartyAccounts = await trace.step(
        "fetch_recurring_payment_counterparty_accounts",
        () => fetchAllCounterpartyWalletAccounts(apiClient.request, recurringPayment.counterpartyId)
      );
      const knownToken = WELL_KNOWN_TOKEN_BY_MINT.get(recurringPayment.token);
      const tokenLabel =
        knownToken?.symbol ??
        wallet?.balances?.find((entry) => entry.mint === recurringPayment.token)?.token ??
        shortenAddress(recurringPayment.token);

      return (
        <RecurringPaymentDetailWorkspace
          recurringPayment={recurringPayment}
          wallet={wallet}
          wallets={wallets}
          counterpartyAccounts={counterpartyAccounts.filter(
            (account) => account.accountKind === "crypto_wallet" && account.status === "active"
          )}
          counterpartyLabel={counterpartyLabel}
          amountLabel={formatDisplayAmount(recurringPayment.amount, tokenLabel)}
          currencyLabel={tokenLabel}
        />
      );
    }
  );
}
