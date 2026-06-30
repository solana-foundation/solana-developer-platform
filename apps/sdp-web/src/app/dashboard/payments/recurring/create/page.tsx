import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { isRecurringPaymentsDashboardEnabled } from "@/lib/recurring-payments-feature";
import { fetchCounterparties } from "../../counterparty/counterparty-page.data";
import { fetchPaymentsIssuedTokenSymbols, fetchPaymentsWallets } from "../../payments-page.data";
import { RecurringPaymentCreateWorkspace } from "../recurring-payment-create-workspace";

export const dynamic = "force-dynamic";

export default async function RecurringPaymentCreatePage() {
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
    "dashboard.recurring-payments.create.page",
    async ({ trace, apiClient }) => {
      const [walletsResult, issuedTokenSymbolsResult, counterpartiesResult] = await Promise.all([
        trace.step("fetch_wallets", () =>
          fetchPaymentsWallets(apiClient.request, { includeBalances: true })
        ),
        trace.step("fetch_issued_token_symbols", () =>
          fetchPaymentsIssuedTokenSymbols(apiClient.request)
        ),
        trace.step("fetch_counterparties", () =>
          fetchCounterparties(apiClient.request, { pageSize: 100 })
        ),
      ]);

      trace.log({
        walletsOk: walletsResult.ok,
        walletCount: walletsResult.data?.length ?? 0,
        issuedTokenSymbolsOk: issuedTokenSymbolsResult.ok,
        issuedTokenSymbolCount: issuedTokenSymbolsResult.data?.length ?? 0,
        counterpartiesOk: counterpartiesResult.ok,
        counterpartyCount: counterpartiesResult.data.length,
      });

      const issuedTokenSymbolsByMint = Object.fromEntries(
        (issuedTokenSymbolsResult.data ?? []).map((token) => [token.mintAddress, token.symbol])
      );

      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          <RecurringPaymentCreateWorkspace
            wallets={walletsResult.data ?? []}
            walletsError={
              walletsResult.ok ? null : (walletsResult.error ?? "Unable to load wallets")
            }
            issuedTokenSymbolsByMint={issuedTokenSymbolsByMint}
            counterpartiesResult={{
              ok: counterpartiesResult.ok,
              data: counterpartiesResult.data,
              error: counterpartiesResult.error,
            }}
          />
        </div>
      );
    }
  );
}
