/** The Transactions list. */
export const PAYMENT_TRANSACTIONS_HREF = "/dashboard/payments/transactions";

/** One transaction's page, by its ledger id (a payment's is its transfer id). */
export function transactionHref(transactionId: string): string {
  return `${PAYMENT_TRANSACTIONS_HREF}/${encodeURIComponent(transactionId)}`;
}

/**
 * `?transaction=<id>` on the Transactions list was the ledger's deep link to one transaction
 * before it had a page; the list sends it there.
 */
export const PAYMENT_TRANSACTION_OPEN_PARAM = "transaction";

/** The Requests list. */
export const PAYMENT_REQUESTS_HREF = "/dashboard/payments/requests";

/** One payment request's page. */
export function paymentRequestHref(requestId: string): string {
  return `${PAYMENT_REQUESTS_HREF}/${encodeURIComponent(requestId)}`;
}

/** The new-request page, which the list's "New" and its empty state lead to. */
export const PAYMENT_REQUEST_NEW_HREF = "/dashboard/payments/requests/new";

/**
 * `?create=1` on the Requests page opened the new-request dialog before the form became its own
 * page; the list still sends it there, so an old link keeps working.
 */
export const PAYMENT_REQUEST_CREATE_PARAM = "create";

/**
 * `?request=<id>` on the Requests page opened that request's details in a dialog, where the
 * new-request page used to land; the list sends it to the request's page now.
 */
export const PAYMENT_REQUEST_OPEN_PARAM = "request";

/**
 * The Payments playground opened on one endpoint. Contacts and Requests send their old
 * `?tab=playground` links here, since the Payments playground now carries their endpoints.
 */
export function paymentsPlaygroundHref(endpointId: string): string {
  return `/dashboard/payments?${new URLSearchParams({ tab: "playground", endpoint: endpointId })}`;
}
