import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import {
  PAYMENT_REQUEST_CREATE_PARAM,
  PAYMENT_REQUEST_NEW_HREF,
  PAYMENT_REQUEST_OPEN_PARAM,
  PAYMENT_REQUESTS_HREF,
  paymentRequestHref,
  paymentsPlaygroundHref,
} from "@/lib/payments-routes";
import { fetchCounterparties } from "../counterparty/counterparty-page.data";
import {
  fetchPaymentRequests,
  PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE,
  parsePaymentRequestsListParams,
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
    const [result, counterpartiesResult] = await Promise.all([
      // One page, as the URL names it: listing reconciles each open request on chain, so the
      // list reads no more than it shows.
      trace.step("fetch_payment_requests", () =>
        fetchPaymentRequests(apiClient.request, {
          page: listState.page,
          pageSize: listState.pageSize,
          ...(listState.status ? { status: listState.status } : {}),
        })
      ),
      // The API's largest page, so the From column names every contact a request is likely to
      // carry (the default page of 10 left the rest as raw ids).
      trace.step("fetch_counterparties", () =>
        fetchCounterparties(apiClient.request, { page: 1, pageSize: 100 })
      ),
    ]);

    trace.log({ ok: result.ok, count: result.data.length, total: result.total });

    const lastPage = Math.max(1, Math.ceil(result.total / listState.pageSize));
    if (result.ok && listState.page > lastPage) {
      // A page past the end (an old link, or requests gone since) lands on the last one.
      const search = new URLSearchParams();
      if (lastPage > 1) search.set("page", String(lastPage));
      if (listState.pageSize !== PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE) {
        search.set("pageSize", String(listState.pageSize));
      }
      if (listState.status) search.set("status", listState.status);
      const query = search.toString();
      redirect(`${PAYMENT_REQUESTS_HREF}${query ? `?${query}` : ""}`);
    }

    return (
      <PaymentRequestsWorkspace
        initialPaymentRequests={result.data}
        total={result.total}
        listState={listState}
        initialError={result.error}
        initialLocalErrorCode={result.localErrorCode}
        counterparties={counterpartiesResult.data}
      />
    );
  });
}

export default PaymentRequestsPage;
