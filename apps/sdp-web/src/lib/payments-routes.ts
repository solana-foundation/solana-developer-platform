/** The Transactions list. */
export const PAYMENT_TRANSACTIONS_HREF = "/dashboard/payments/transactions";

/** One transaction's page, by its ledger id (a payment's is its transfer id). */
export function transactionHref(transactionId: string): string {
  return `${PAYMENT_TRANSACTIONS_HREF}/${encodeURIComponent(transactionId)}`;
}

/** The Recurring payments list. */
export const PAYMENT_RECURRING_HREF = "/dashboard/payments/recurring";

/** The Requests list. */
export const PAYMENT_REQUESTS_HREF = "/dashboard/payments/requests";

/** One payment request's page. */
export function paymentRequestHref(requestId: string): string {
  return `${PAYMENT_REQUESTS_HREF}/${encodeURIComponent(requestId)}`;
}

/** The new-request page, which the list's "New" and its empty state lead to. */
export const PAYMENT_REQUEST_NEW_HREF = "/dashboard/payments/requests/new";
