import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import {
  PAYMENT_REQUEST_CREATE_PARAM,
  PAYMENT_REQUEST_NEW_HREF,
  paymentsPlaygroundHref,
} from "@/lib/payments-routes";
import { fetchCounterparties } from "../counterparty/counterparty-page.data";
import { fetchPaymentsWallets } from "../payments-page.data";
import { fetchPaymentRequestDirectory } from "./payment-requests-page.data";
import { PaymentRequestsWorkspace } from "./payment-requests-workspace";

export const dynamic = "force-dynamic";

export default async function PaymentRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }
  const params = await searchParams;
  if (params.tab === "playground") {
    // Requests no longer has a playground tab; its endpoints moved into the Payments one.
    redirect(paymentsPlaygroundHref("list-payment-requests"));
  }
  if (params[PAYMENT_REQUEST_CREATE_PARAM] === "1") {
    // The new-request form was a dialog here; it is its own page now.
    redirect(PAYMENT_REQUEST_NEW_HREF);
  }

  return withDashboardPageTrace("dashboard.payment-requests.page", async ({ trace, apiClient }) => {
    const [result, walletsResult, counterpartiesResult] = await Promise.all([
      trace.step("fetch_payment_requests", () => fetchPaymentRequestDirectory(apiClient.request)),
      trace.step("fetch_wallets", () => fetchPaymentsWallets(apiClient.request)),
      // The API's largest page, so the From column names every contact a request is likely to
      // carry (the default page of 10 left the rest as raw ids).
      trace.step("fetch_counterparties", () =>
        fetchCounterparties(apiClient.request, { page: 1, pageSize: 100 })
      ),
    ]);

    trace.log({ ok: result.ok, count: result.data.length, total: result.total });

    const wallets = walletsResult.ok && walletsResult.data ? walletsResult.data : [];

    return (
      <PaymentRequestsWorkspace
        initialPaymentRequests={result.data}
        total={result.total}
        initialError={result.error}
        initialLocalErrorCode={result.localErrorCode}
        wallets={wallets}
        counterparties={counterpartiesResult.data}
      />
    );
  });
}
