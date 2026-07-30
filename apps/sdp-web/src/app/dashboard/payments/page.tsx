import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import { DashboardWorkspaceTabShell } from "@/components/dashboard-workspace-tab-shell";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../playground-api-data";
import { PaymentsCommandCenter } from "./payments-command-center";
import { fetchPaymentsWallets, fetchPaymentTransfers } from "./payments-page.data";
import { PaymentsPlaygroundWorkspace } from "./payments-workspace";

type ApiClientPromise = ReturnType<typeof createSdpApiClient>;
type Trace = ReturnType<typeof createTimedTrace>;

async function PaymentsPlaygroundData({
  apiClientPromise,
  trace,
}: {
  apiClientPromise: ApiClientPromise;
  trace: Trace;
}) {
  const [t, apiClient] = await Promise.all([getTranslations(), apiClientPromise]);
  const [apiKeysResult, walletsResult, transfersResult] = await Promise.all([
    trace.step("fetch_active_api_keys", () => fetchActiveApiKeys(apiClient.request)),
    trace.step("fetch_payments_wallet_summaries", () =>
      fetchPaymentsWallets(apiClient.request, { view: "summary" })
    ),
    trace.step("fetch_payment_transfers", () => fetchPaymentTransfers(apiClient.request)),
  ]);
  const wallets = walletsResult.data ?? [];
  const transfers = transfersResult.data ?? [];
  const walletsError = walletsResult.ok
    ? null
    : t("DashboardPayments.page.walletApiError", {
        status: walletsResult.status ?? t("DashboardPayments.page.unavailableStatus"),
        error: walletsResult.error ?? t("DashboardPayments.page.unknownError"),
      });
  const transfersError = transfersResult.ok
    ? null
    : t("DashboardPayments.page.transferApiError", {
        status: transfersResult.status ?? t("DashboardPayments.page.unavailableStatus"),
        error: transfersResult.error ?? t("DashboardPayments.page.unknownError"),
      });

  trace.log({
    ok: true,
    walletCount: wallets.length,
    transferCount: transfers.length,
    apiKeyCount: apiKeysResult.data?.length ?? 0,
  });

  return (
    <PaymentsPlaygroundWorkspace
      apiBaseUrl={resolvePlaygroundApiBaseUrl()}
      apiKeys={apiKeysResult.data ?? []}
      wallets={wallets}
      walletsError={walletsError}
      transfers={transfers}
      transfersError={transfersError}
    />
  );
}

export default async function PaymentsPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.payments.page");
  const apiClientPromise = trace.step("create_sdp_api_client", () =>
    createSdpApiClient(trace.childContext("dashboard.payments.api"))
  );

  return (
    <DashboardWorkspaceTabShell
      overviewKey="payments-overview-tab"
      playgroundKey="payments-playground-tab"
      overview={
        <PaymentsCommandCenter apiClientPromise={apiClientPromise} organizationId={orgId} />
      }
      playground={
        <Suspense fallback={<ApiPlaygroundShellSkeleton />}>
          <PaymentsPlaygroundData apiClientPromise={apiClientPromise} trace={trace} />
        </Suspense>
      }
    />
  );
}
