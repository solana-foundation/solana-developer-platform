import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../../playground-api-data";
import { fetchCounterparties } from "../counterparty/counterparty-page.data";
import { fetchPaymentsWallets } from "../payments-page.data";
import { fetchPaymentRequests } from "./payment-requests-page.data";
import { PaymentRequestsWorkspace } from "./payment-requests-workspace";

export const dynamic = "force-dynamic";

interface PaymentRequestsPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PaymentRequestsPage({ searchParams }: PaymentRequestsPageProps) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiBaseUrl = resolvePlaygroundApiBaseUrl();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const isPlayground =
    resolvedSearchParams?.tab === "playground" ||
    (Array.isArray(resolvedSearchParams?.tab) && resolvedSearchParams.tab[0] === "playground");

  return withDashboardPageTrace("dashboard.payment-requests.page", async ({ trace, apiClient }) => {
    const apiKeysPromise = isPlayground
      ? trace.step("fetch_active_api_keys", () => fetchActiveApiKeys(apiClient.request))
      : Promise.resolve(null);
    const [result, walletsResult, counterpartiesResult, apiKeysResult] = await Promise.all([
      trace.step("fetch_payment_requests", () => fetchPaymentRequests(apiClient.request)),
      trace.step("fetch_wallets", () => fetchPaymentsWallets(apiClient.request)),
      trace.step("fetch_counterparties", () => fetchCounterparties(apiClient.request)),
      apiKeysPromise,
    ]);

    trace.log({ ok: result.ok, count: result.data.length, total: result.total });

    const wallets = walletsResult.ok && walletsResult.data ? walletsResult.data : [];

    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <PaymentRequestsWorkspace
          initialPaymentRequests={result.data}
          initialError={result.error}
          initialLocalErrorCode={result.localErrorCode}
          apiBaseUrl={apiBaseUrl}
          apiKeys={apiKeysResult?.ok && apiKeysResult.data ? apiKeysResult.data : []}
          wallets={wallets}
          counterparties={counterpartiesResult.data}
        />
      </div>
    );
  });
}
