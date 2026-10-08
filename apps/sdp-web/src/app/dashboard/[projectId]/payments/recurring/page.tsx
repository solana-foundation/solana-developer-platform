import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { fetchCounterparty } from "../counterparty/counterparty-page.data";
import { fetchPaymentsIssuedTokenSymbols, fetchPaymentsWallets } from "../payments-page.data";
import {
  fetchRecurringPayments,
  parseRecurringPaymentsListParams,
} from "./recurring-payments.data";
import { RecurringPaymentsWorkspace } from "./recurring-payments-workspace";

export const dynamic = "force-dynamic";

interface RecurringPaymentsPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RecurringPaymentsPage({ searchParams }: RecurringPaymentsPageProps) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const listState = parseRecurringPaymentsListParams((await searchParams) ?? {});

  return withDashboardPageTrace(
    "dashboard.recurring-payments.page",
    async ({ trace, apiClient }) => {
      const t = await getTranslations();
      const [recurringPaymentsResult, walletsResult, issuedTokenSymbolsResult] = await Promise.all([
        trace.step("fetch_recurring_payments", () =>
          fetchRecurringPayments(apiClient.request, t, listState)
        ),
        trace.step("fetch_wallets", () =>
          fetchPaymentsWallets(apiClient.request, { includeBalances: true })
        ),
        trace.step("fetch_issued_token_symbols", () =>
          fetchPaymentsIssuedTokenSymbols(apiClient.request)
        ),
      ]);
      if (!recurringPaymentsResult.ok) {
        throw new Error(recurringPaymentsResult.error);
      }
      const recurringPayments = recurringPaymentsResult.data;
      const issuedTokensByMint = Object.fromEntries(
        (issuedTokenSymbolsResult.data ?? []).map((token) => [token.mintAddress, token])
      );
      const counterpartyIds = [
        ...new Set(recurringPayments.recurringPayments.map((payment) => payment.counterpartyId)),
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
        recurringPaymentCount: recurringPayments.recurringPayments.length,
        recurringPaymentTotal: recurringPayments.total,
        walletsOk: walletsResult.ok,
        walletCount: walletsResult.data?.length ?? 0,
        counterpartiesOk: resolvedCounterparties.length === counterpartyIds.length,
        counterpartyCount: resolvedCounterparties.length,
      });

      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          <RecurringPaymentsWorkspace
            initialRecurringPayments={recurringPayments.recurringPayments}
            total={recurringPayments.total}
            listState={listState}
            issuedTokensByMint={issuedTokensByMint}
            initialError={undefined}
            wallets={walletsResult.data ?? []}
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
