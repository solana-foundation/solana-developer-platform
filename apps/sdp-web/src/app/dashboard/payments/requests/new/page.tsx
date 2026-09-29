import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { fetchCounterparties } from "../../counterparty/counterparty-page.data";
import { fetchPaymentsWallets } from "../../payments-page.data";
import { PaymentRequestCreateWorkspace } from "../payment-request-create-workspace";

export const dynamic = "force-dynamic";

export default async function PaymentRequestCreatePage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  return withDashboardPageTrace(
    "dashboard.payment-requests.create.page",
    async ({ trace, apiClient }) => {
      const [walletsResult, counterpartiesResult] = await Promise.all([
        trace.step("fetch_wallets", () => fetchPaymentsWallets(apiClient.request)),
        // The API's largest page, so From offers every contact a project is likely to have.
        trace.step("fetch_counterparties", () =>
          fetchCounterparties(apiClient.request, { page: 1, pageSize: 100 })
        ),
      ]);

      trace.log({
        walletsOk: walletsResult.ok,
        walletCount: walletsResult.data?.length ?? 0,
        counterpartiesOk: counterpartiesResult.ok,
        counterpartyCount: counterpartiesResult.data.length,
      });

      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          <PaymentRequestCreateWorkspace
            wallets={walletsResult.data ?? []}
            walletsError={
              walletsResult.ok ? null : (walletsResult.error ?? "Unable to load wallets")
            }
            counterparties={counterpartiesResult.data}
          />
        </div>
      );
    }
  );
}
