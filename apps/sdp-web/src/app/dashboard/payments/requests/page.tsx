import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { RENDER_SCOPE_TTL_SECONDS, sealRenderScope } from "@/lib/render-scope";
import { getSelectedProjectId } from "@/lib/sdp-api";
import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "../../playground-api-data";
import { fetchCounterparties } from "../counterparty/counterparty-page.data";
import { fetchPaymentsWallets } from "../payments-page.data";
import { fetchPaymentRequests } from "./payment-requests-page.data";
import { PaymentRequestsWorkspace } from "./payment-requests-workspace";

export const dynamic = "force-dynamic";

export default async function PaymentRequestsPage() {
  const { userId, orgId, sessionId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiBaseUrl = resolvePlaygroundApiBaseUrl();

  return withDashboardPageTrace("dashboard.payment-requests.page", async ({ trace, apiClient }) => {
    const [result, walletsResult, counterpartiesResult, apiKeysResult, renderScope] =
      await Promise.all([
        trace.step("fetch_payment_requests", () => fetchPaymentRequests(apiClient.request)),
        trace.step("fetch_wallets", () => fetchPaymentsWallets(apiClient.request)),
        trace.step("fetch_counterparties", () => fetchCounterparties(apiClient.request)),
        trace.step("fetch_active_api_keys", () => fetchActiveApiKeys(apiClient.request)),
        // Seals the project this page rendered with into a short-lived scope
        // the create modal must present back; the BFF refuses creates whose
        // scope no longer matches the cookie-derived selection (APE-706).
        trace.step("seal_render_scope", async () => {
          const projectId = await getSelectedProjectId();
          if (!projectId || !sessionId) {
            return null;
          }
          return sealRenderScope({ projectId }, { sessionId, userId }, RENDER_SCOPE_TTL_SECONDS);
        }),
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
          apiKeys={apiKeysResult.data ?? []}
          wallets={wallets}
          counterparties={counterpartiesResult.data}
          renderScope={renderScope}
        />
      </div>
    );
  });
}
