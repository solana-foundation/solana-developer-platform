/** The Requests list. */
export const PAYMENT_REQUESTS_HREF = "/dashboard/payments/requests";

/** The new-request page, which the list's "New" and its empty state lead to. */
export const PAYMENT_REQUEST_NEW_HREF = "/dashboard/payments/requests/new";

/**
 * `?create=1` on the Requests page opened the new-request dialog before the form became its own
 * page; the list still sends it there, so an old link keeps working.
 */
export const PAYMENT_REQUEST_CREATE_PARAM = "create";

/**
 * `?request=<id>` on the Requests page opens that request's details once, which is where the
 * new-request page lands after creating one.
 */
export const PAYMENT_REQUEST_OPEN_PARAM = "request";

/**
 * The Payments playground opened on one endpoint. Contacts and Requests send their old
 * `?tab=playground` links here, since the Payments playground now carries their endpoints.
 */
export function paymentsPlaygroundHref(endpointId: string): string {
  return `/dashboard/payments?${new URLSearchParams({ tab: "playground", endpoint: endpointId })}`;
}
