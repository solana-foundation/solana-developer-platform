import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { lookupCounterparty } from "@/app/(session)/dashboard/[projectId]/payments/counterparty/counterparty-page.data";
import { fetchIssuedTokenSymbolsWhenIssuanceEnabled } from "@/app/(session)/dashboard/[projectId]/payments/issued-tokens.server";
import { fetchPaymentsWallets } from "@/app/(session)/dashboard/[projectId]/payments/payments-page.data";
import { getTranslations } from "@/i18n/server";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import {
  fetchRecurringPayments,
  parseRecurringPaymentsListParams,
  recurringPaymentCounterpartyViews,
} from "./recurring-payments.data";
import { RecurringPaymentsWorkspace } from "./recurring-payments-workspace";

export const dynamic = "force-dynamic";

interface RecurringPaymentsPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RecurringPaymentsPage({ searchParams }: RecurringPaymentsPageProps) {
  const { orgId } = await auth();
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
          fetchIssuedTokenSymbolsWhenIssuanceEnabled(apiClient.request)
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
      const lookups = await trace.step("fetch_recurring_payment_counterparties", () =>
        Promise.all(
          counterpartyIds.map(async (id) => ({
            id,
            lookup: await lookupCounterparty(apiClient.request, id),
          }))
        )
      );
      const counterparties = recurringPaymentCounterpartyViews(
        lookups,
        t("DashboardPayments.recurring.counterpartyArchived")
      );

      trace.log({
        ok: recurringPaymentsResult.ok,
        recurringPaymentCount: recurringPayments.recurringPayments.length,
        recurringPaymentTotal: recurringPayments.total,
        walletsOk: walletsResult.ok,
        walletCount: walletsResult.data?.length ?? 0,
        counterpartiesOk: counterparties.failed === 0,
        counterpartyCount: counterparties.counterparties.length,
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
            counterparties={counterparties.counterparties}
            lookupError={
              walletsResult.ok && counterparties.failed === 0
                ? undefined
                : [
                    walletsResult.ok ? null : (walletsResult.error ?? "Unable to load wallets"),
                    counterparties.failed === 0 ? null : "Unable to load some counterparties",
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
