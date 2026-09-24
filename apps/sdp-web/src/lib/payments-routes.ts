/**
 * `?create=1` on the Requests page opens the new-request dialog, so the header's "New" action
 * can be a plain link rendered by the shell.
 */
export const PAYMENT_REQUEST_CREATE_PARAM = "create";

/**
 * The Payments playground opened on one endpoint. Contacts and Requests send their old
 * `?tab=playground` links here, since the Payments playground now carries their endpoints.
 */
export function paymentsPlaygroundHref(endpointId: string): string {
  return `/dashboard/payments?${new URLSearchParams({ tab: "playground", endpoint: endpointId })}`;
}
