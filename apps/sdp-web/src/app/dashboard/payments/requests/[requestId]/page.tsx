import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { PAYMENT_REQUESTS_HREF } from "@/lib/payments-routes";
import { fetchCounterparty } from "../../counterparty/counterparty-page.data";
import { fetchPaymentsWallets } from "../../payments-page.data";
import { PaymentRequestDetailWorkspace } from "../payment-request-detail-workspace";
import { fetchPaymentRequestDetail } from "../payment-requests-page.data";

export const dynamic = "force-dynamic";

export default async function PaymentRequestDetailRoute({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const { requestId } = await params;

  return withDashboardPageTrace(
    "dashboard.payment-requests.detail.page",
    async ({ trace, apiClient }) => {
      const [detail, walletsResult] = await Promise.all([
        trace.step("fetch_payment_request", () =>
          fetchPaymentRequestDetail(apiClient.request, requestId)
        ),
        trace.step("fetch_wallets", () => fetchPaymentsWallets(apiClient.request)),
      ]);

      trace.log({ status: detail.status });

      if (detail.status === "not_found") {
        redirect(PAYMENT_REQUESTS_HREF);
      }

      const request = detail.status === "found" ? detail.request : null;
      const contact = request?.counterpartyId
        ? await trace.step("fetch_counterparty", () =>
            fetchCounterparty(apiClient.request, request.counterpartyId as string)
          )
        : null;
      const wallet = request
        ? (walletsResult.data ?? []).find(
            (candidate) =>
              candidate.walletId === request.walletId || candidate.id === request.walletId
          )
        : undefined;

      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          <PaymentRequestDetailWorkspace
            request={request}
            contactName={contact?.displayName ?? null}
            walletName={wallet?.label ?? null}
            error={detail.status === "error" ? detail.error : undefined}
          />
        </div>
      );
    }
  );
}
