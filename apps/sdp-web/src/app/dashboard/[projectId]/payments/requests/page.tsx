import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchPaymentsWallets } from "@/app/dashboard/[projectId]/payments/payments-page.data";
import { resolvePlaygroundApiBaseUrl } from "@/app/dashboard/[projectId]/playground-api-data";
import { withLegacyDesign } from "@/flags/new-design";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { PaymentRequestsPage as RedesignPaymentRequestsPage } from "./page.redesign";
import { fetchPaymentRequests } from "./payment-requests-page.data";
import { PaymentRequestsWorkspace } from "./payment-requests-workspace";

export const dynamic = "force-dynamic";

async function PaymentRequestsPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiBaseUrl = resolvePlaygroundApiBaseUrl();

  return withDashboardPageTrace("dashboard.payment-requests.page", async ({ trace, apiClient }) => {
    const [result, walletsResult] = await Promise.all([
      trace.step("fetch_payment_requests", () => fetchPaymentRequests(apiClient.request)),
      trace.step("fetch_wallets", () => fetchPaymentsWallets(apiClient.request)),
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
          wallets={wallets}
        />
      </div>
    );
  });
}

export default withLegacyDesign(RedesignPaymentRequestsPage, PaymentRequestsPage, "activity");
