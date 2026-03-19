import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import {
  buildHomeActivityRows,
  computeTodaysVolume,
  fetchIssuanceTokens,
  fetchOrgIssuanceActivity,
} from "./home-page.data";
import { HomeWorkspace } from "./home-workspace";
import {
  aggregateBalancesFromWallets,
  resolveTotalBalance,
} from "./payments/payments-overview.utils";
import {
  fetchPaymentTransfers,
  fetchPaymentsAggregate,
  fetchPaymentsWallets,
} from "./payments/payments-page.data";

export default async function DashboardPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    return null;
  }

  const trace = createTimedTrace("dashboard.home.page");

  try {
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.home.api"))
    );
    const [aggregateResult, transfersResult, walletsResult, issuanceTokensResult] =
      await Promise.all([
        trace.step("fetch_payments_aggregate", () => fetchPaymentsAggregate(apiClient.request)),
        trace.step("fetch_payment_transfers", () => fetchPaymentTransfers(apiClient.request, 100)),
        trace.step("fetch_payments_wallets", () =>
          fetchPaymentsWallets(apiClient.request, { includeBalances: false })
        ),
        trace.step("fetch_issuance_tokens", () => fetchIssuanceTokens(apiClient.request, 10)),
      ]);
    const issuanceTokens = issuanceTokensResult.data ?? [];

    const issuanceActivityResult =
      issuanceTokensResult.ok && issuanceTokens.length > 0
        ? await trace.step("fetch_issuance_activity", () =>
            fetchOrgIssuanceActivity(apiClient.request, issuanceTokens)
          )
        : { rows: [], error: null };

    const wallets = walletsResult.data ?? [];
    const isWalletEmptyState = walletsResult.ok && wallets.length === 0;
    const totalBalance = aggregateResult.data?.balances
      ? resolveTotalBalance(aggregateResult.data.balances)
      : resolveTotalBalance(aggregateBalancesFromWallets(wallets));
    const todaysVolume = transfersResult.data ? computeTodaysVolume(transfersResult.data) : null;
    const activityRows = buildHomeActivityRows(
      transfersResult.data ?? [],
      issuanceActivityResult.rows
    );

    const aggregateError =
      aggregateResult.ok || isWalletEmptyState ? null : "Balance data is unavailable right now.";
    const transfersError =
      transfersResult.ok || isWalletEmptyState
        ? null
        : "Payments activity is unavailable right now.";
    const issuanceTokensError = issuanceTokensResult.ok
      ? null
      : "Issuance activity is unavailable right now.";

    const activityError =
      activityRows.length === 0
        ? (transfersError ?? issuanceTokensError ?? issuanceActivityResult.error)
        : null;
    const activityNotice = [transfersError, issuanceTokensError, issuanceActivityResult.error]
      .filter(Boolean)
      .join(" ");

    trace.log({
      ok: true,
      walletCount: wallets.length,
      activityRowCount: activityRows.length,
      hasAggregate: Boolean(aggregateResult.data?.balances),
    });

    return (
      <HomeWorkspace
        totalBalance={totalBalance}
        totalBalanceError={aggregateError}
        todaysVolume={todaysVolume}
        todaysVolumeError={transfersError}
        activityRows={activityRows}
        activityError={activityError}
        activityNotice={activityNotice || null}
        wallets={wallets}
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
