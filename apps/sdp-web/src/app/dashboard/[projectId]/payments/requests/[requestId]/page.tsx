import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchPaymentsWallets } from "@/app/dashboard/[projectId]/payments/payments-page.data";
import { PaymentRequestDetailWorkspace } from "@/app/dashboard/[projectId]/payments/requests/payment-request-detail-workspace";
import {
  fetchPaymentRequestDetail,
  fetchPaymentRequestLinkToken,
} from "@/app/dashboard/[projectId]/payments/requests/payment-requests-page.data";
import { withLegacyDesign } from "@/flags/new-design";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { PAYMENT_REQUESTS_HREF } from "@/lib/payments-routes";
import { requestProjectHref } from "@/lib/sdp-api";

export const dynamic = "force-dynamic";

async function PaymentRequestDetailRoute({ params }: { params: Promise<{ requestId: string }> }) {
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
      const [detail, link, walletsResult] = await Promise.all([
        trace.step("fetch_payment_request", () =>
          fetchPaymentRequestDetail(apiClient.request, requestId)
        ),
        trace.step("fetch_payment_request_link", () =>
          fetchPaymentRequestLinkToken(apiClient.request, requestId)
        ),
        trace.step("fetch_wallets", () => fetchPaymentsWallets(apiClient.request)),
      ]);

      trace.log({ status: detail.status });

      if (detail.status === "not_found") {
        redirect(await requestProjectHref(PAYMENT_REQUESTS_HREF));
      }

      const request = detail.status === "found" ? detail.request : null;
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
            publicToken={link.ok ? link.publicToken : null}
            walletName={wallet?.label ?? null}
            error={detail.status === "error" ? detail.error : undefined}
          />
        </div>
      );
    }
  );
}

/** The previous design has no request page and no link to one request: the list it is on. */
async function LegacyPaymentRequestDetailRoute(): Promise<never> {
  redirect(await requestProjectHref(PAYMENT_REQUESTS_HREF));
}

export default withLegacyDesign(
  PaymentRequestDetailRoute,
  LegacyPaymentRequestDetailRoute,
  "activity"
);
