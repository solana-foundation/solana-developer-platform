import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { HomeWorkspace } from "./home-workspace";
import { resolveTotalBalance } from "./payments/payments-overview.utils";
import {
  fetchPaymentsAggregate,
  fetchPaymentsIssuedTokenSymbols,
  fetchPaymentsWallets,
} from "./payments/payments-page.data";

export default async function DashboardPage() {
  const t = await getTranslations();
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    return null;
  }

  const trace = createTimedTrace("dashboard.home.page");
  try {
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.home.api"))
    );
    const [aggregateResult, walletsResult, issuedTokensResult] = await Promise.all([
      trace.step("fetch_payments_aggregate", () => fetchPaymentsAggregate(apiClient.request)),
      trace.step("fetch_wallet_summaries", () =>
        fetchPaymentsWallets(apiClient.request, { view: "summary" })
      ),
      trace.step("fetch_issued_token_symbols", () =>
        fetchPaymentsIssuedTokenSymbols(apiClient.request)
      ),
    ]);

    const wallets = walletsResult.data ?? [];
    const isWalletEmptyState = walletsResult.ok && wallets.length === 0;
    const balances = aggregateResult.data?.balances ?? [];
    const totalBalance = resolveTotalBalance(balances);

    const aggregateError =
      aggregateResult.ok || isWalletEmptyState
        ? null
        : t("Shared.homeWorkspace.balanceDataUnavailable");

    trace.log({
      ok: true,
      walletCount: wallets.length,
      hasAggregate: Boolean(aggregateResult.data?.balances),
    });

    return (
      <HomeWorkspace
        totalBalance={totalBalance}
        totalBalanceError={aggregateError}
        wallets={wallets}
        // Already on the wire for the total; the home page used to discard the
        // per-token rows and the wallet count that came back with it.
        balances={balances}
        walletCount={aggregateResult.data?.walletCount ?? wallets.length}
        issuedTokens={issuedTokensResult.data ?? []}
      />
    );
  } catch (error) {
    trace.log({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}
