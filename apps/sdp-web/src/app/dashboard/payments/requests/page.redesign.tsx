import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import {
  PAYMENT_REQUEST_CREATE_PARAM,
  PAYMENT_REQUEST_NEW_HREF,
  PAYMENT_REQUEST_OPEN_PARAM,
  paymentRequestHref,
  paymentsPlaygroundHref,
} from "@/lib/payments-routes";
import { fetchCounterparties } from "../counterparty/counterparty-page.data";
import {
  loadPaymentRequestsList,
  parsePaymentRequestsListParams,
  paymentRequestsListHref,
} from "./payment-requests-page.data";
import { PaymentRequestsWorkspace } from "./payment-requests-workspace.redesign";

async function PaymentRequestsPage({
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
  const openId = params[PAYMENT_REQUEST_OPEN_PARAM];
  if (typeof openId === "string" && openId !== "") {
    // One request opened in a dialog here; it has its own page now.
    redirect(paymentRequestHref(openId));
  }

  const listState = parsePaymentRequestsListParams(params);

  return withDashboardPageTrace("dashboard.payment-requests.page", async ({ trace, apiClient }) => {
    // The API's largest page, so the From column names every contact a request is likely to
    // carry (the default page of 10 left the rest as raw ids).
    const counterpartiesLoad = trace.step("fetch_counterparties", () =>
      fetchCounterparties(apiClient.request, { page: 1, pageSize: 100 })
    );
    const [result, counterpartiesResult] = await Promise.all([
      // One page, as the URL names it: listing reconciles each open request on chain, so the
      // list reads no more than it shows, unless it is searched or the status is one a payment
      // can change (see loadPaymentRequestsList).
      trace.step("fetch_payment_requests", () =>
        loadPaymentRequestsList(apiClient.request, listState, {
          counterpartyNames: async () =>
            new Map(
              (await counterpartiesLoad).data.map((counterparty) => [
                counterparty.id,
                counterparty.displayName,
              ])
            ),
        })
      ),
      counterpartiesLoad,
    ]);

    trace.log({
      ok: result.ok,
      count: result.data.length,
      total: result.total,
      searchCapped: result.searchCapped,
    });

    const lastPage = Math.max(1, Math.ceil(result.total / listState.pageSize));
    if (result.ok && listState.page > lastPage) {
      // A page past the end (an old link, or requests gone since) lands on the last one.
      redirect(paymentRequestsListHref({ ...listState, page: lastPage }));
    }

    return (
      <PaymentRequestsWorkspace
        initialPaymentRequests={result.data}
        total={result.total}
        searchCapped={result.searchCapped}
        listState={listState}
        initialError={result.error}
        initialLocalErrorCode={result.localErrorCode}
        counterparties={counterpartiesResult.data}
      />
    );
  });
}

export default PaymentRequestsPage;
