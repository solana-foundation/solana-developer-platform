import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { HomeWorkspace } from "./home-workspace";
import { resolveTotalBalance } from "./payments/payments-overview.utils";
import { fetchPaymentsAggregate, fetchPaymentsWallets } from "./payments/payments-page.data";

export default async function DashboardPage() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    return null;
  }

  const trace = createTimedTrace("dashboard.home.page");
  const dashboardAccess = resolveDashboardAccess(orgRole);

  try {
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.home.api"))
    );
    const [aggregateResult, walletsResult] = await Promise.all([
      trace.step("fetch_payments_aggregate", () => fetchPaymentsAggregate(apiClient.request)),
      trace.step("fetch_wallet_summaries", () =>
        fetchPaymentsWallets(apiClient.request, { view: "summary" })
      ),
    ]);

    const wallets = walletsResult.data ?? [];
    const isWalletEmptyState = walletsResult.ok && wallets.length === 0;
    const totalBalance = resolveTotalBalance(aggregateResult.data?.balances ?? []);

    const aggregateError =
      aggregateResult.ok || isWalletEmptyState ? null : "Balance data is unavailable right now.";

    trace.log({
      ok: true,
      walletCount: wallets.length,
      hasAggregate: Boolean(aggregateResult.data?.balances),
    });

    return (
      <HomeWorkspace
        dashboardAccess={dashboardAccess}
        totalBalance={totalBalance}
        totalBalanceError={aggregateError}
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
