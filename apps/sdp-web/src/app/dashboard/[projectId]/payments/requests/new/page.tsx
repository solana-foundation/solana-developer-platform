import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchPaymentsWallets } from "@/app/dashboard/[projectId]/payments/payments-page.data";
import { PaymentRequestCreateWorkspace } from "@/app/dashboard/[projectId]/payments/requests/payment-request-create-workspace";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";

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
      const walletsResult = await trace.step("fetch_wallets", () =>
        fetchPaymentsWallets(apiClient.request)
      );

      trace.log({
        walletsOk: walletsResult.ok,
        walletCount: walletsResult.data?.length ?? 0,
      });

      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          <PaymentRequestCreateWorkspace
            wallets={walletsResult.data ?? []}
            walletsError={
              walletsResult.ok ? null : (walletsResult.error ?? "Unable to load wallets")
            }
          />
        </div>
      );
    }
  );
}
