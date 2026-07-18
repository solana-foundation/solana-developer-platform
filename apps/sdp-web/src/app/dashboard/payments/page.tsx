import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getTranslations } from "@/i18n/server";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../playground-api-data";
import { PaymentsCommandCenter } from "./payments-command-center";
import { fetchPaymentsWallets, fetchPaymentTransfers } from "./payments-page.data";
import { PaymentsWorkspace } from "./payments-workspace";
import { PaymentsOverviewTabs } from "./payments-workspace-tabs";

interface PaymentsPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PaymentsPage({ searchParams }: PaymentsPageProps) {
  const t = await getTranslations();
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.payments.page");

  try {
    const resolvedSearchParams = searchParams ? await searchParams : undefined;
    const currentTab =
      resolvedSearchParams?.tab === "playground" ||
      (Array.isArray(resolvedSearchParams?.tab) && resolvedSearchParams.tab[0] === "playground")
        ? "playground"
        : "overview";
    const apiClientPromise = trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.payments.api"))
    );

    if (currentTab === "overview") {
      trace.log({ ok: true, tab: currentTab, phase: "static_actions" });
      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          <PaymentsOverviewTabs value="overview" />
          <div className="min-h-0 flex-1">
            <PaymentsCommandCenter apiClientPromise={apiClientPromise} organizationId={orgId} />
          </div>
        </div>
      );
    }

    const apiClient = await apiClientPromise;
    const apiBaseUrl = resolvePlaygroundApiBaseUrl();
    const [apiKeysResult, walletsResult, transfersResult] = await Promise.all([
      trace.step("fetch_active_api_keys", () => fetchActiveApiKeys(apiClient.request)),
      trace.step("fetch_payments_wallet_summaries", () =>
        fetchPaymentsWallets(apiClient.request, { view: "summary" })
      ),
      trace.step("fetch_payment_transfers", () => fetchPaymentTransfers(apiClient.request)),
    ]);
    const apiKeys = apiKeysResult.data ?? [];
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
      tab: currentTab,
      walletCount: wallets.length,
      transferCount: transfers.length,
      apiKeyCount: apiKeys.length,
    });

    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <PaymentsOverviewTabs value="playground" />
        <div className="min-h-0 flex-1">
          <PaymentsWorkspace
            activeTab="playground"
            apiBaseUrl={apiBaseUrl}
            apiKeys={apiKeys}
            wallets={wallets}
            walletsError={walletsError}
            aggregate={null}
            aggregateError={null}
            issuedTokenSymbolsByMint={{}}
            transfers={transfers}
            transfersError={transfersError}
          />
        </div>
      </div>
    );
  } catch (error) {
    trace.log({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}
