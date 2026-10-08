/** The Transactions list. */
export const PAYMENT_TRANSACTIONS_HREF = "/dashboard/payments/transactions";

/** The Requests list. */
export const PAYMENT_REQUESTS_HREF = "/dashboard/payments/requests";

/**
 * The Payments playground opened on one endpoint. Contacts has no playground tab of its own, so
 * its old `?tab=playground` links come here.
 */
export function paymentsPlaygroundHref(endpointId: string): string {
  return `/dashboard/payments?${new URLSearchParams({ tab: "playground", endpoint: endpointId })}`;
}
