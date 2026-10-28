import { PAYMENT_RECURRING_HREF, PAYMENT_REQUESTS_HREF } from "@/lib/payments-routes";

/**
 * Who set a payment up, as the payment lists filter by it: an API key, which the API also
 * matches against the keys it was rotated from, or a member acting directly in the dashboard.
 */
export type PaymentPrincipalFilter =
  | { kind: "api_key"; apiKeyId: string }
  | { kind: "member"; userId: string };

/** The query params one payment list names its principal filter with. */
export interface PaymentPrincipalParams {
  apiKey: string;
  user: string;
}

/** The recurring payments list filters by who activated a schedule. */
export const RECURRING_ACTIVATED_BY_PARAMS = {
  apiKey: "activatedByApiKeyId",
  user: "activatedByUserId",
} as const satisfies PaymentPrincipalParams;

/** The payment requests list filters by who created a request. */
export const PAYMENT_REQUEST_CREATED_BY_PARAMS = {
  apiKey: "createdByApiKeyId",
  user: "createdByUserId",
} as const satisfies PaymentPrincipalParams;

function firstParamValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A list's principal filter from its URL. An API key wins when both are present, since the API
 * refuses a request naming both.
 *
 * @param params - The route's search params.
 * @param names - The list's param names.
 * @returns The filter, or null when the URL names none.
 */
export function parsePaymentPrincipalParams(
  params: Record<string, string | string[] | undefined>,
  names: PaymentPrincipalParams
): PaymentPrincipalFilter | null {
  const apiKeyId = firstParamValue(params[names.apiKey])?.trim();
  if (apiKeyId) {
    return { kind: "api_key", apiKeyId };
  }
  const userId = firstParamValue(params[names.user])?.trim();
  if (userId) {
    return { kind: "member", userId };
  }
  return null;
}

/**
 * Write a principal filter into a list query, replacing whichever one it held.
 *
 * @param query - The query to change.
 * @param filter - The filter, or null to clear it.
 * @param names - The list's param names.
 */
export function setPaymentPrincipalParams(
  query: URLSearchParams,
  filter: PaymentPrincipalFilter | null,
  names: PaymentPrincipalParams
): void {
  query.delete(names.apiKey);
  query.delete(names.user);
  if (filter === null) {
    return;
  }
  switch (filter.kind) {
    case "api_key":
      query.set(names.apiKey, filter.apiKeyId);
      return;
    case "member":
      query.set(names.user, filter.userId);
      return;
    default: {
      const unreachable: never = filter;
      throw new Error(`Unhandled payment principal filter ${String(unreachable)}`);
    }
  }
}

/**
 * The Schedules list showing the active recurring payments a principal set up, which keep
 * collecting after the key is revoked or the member removed.
 *
 * @param filter - The principal.
 * @returns A project-less dashboard path.
 */
export function linkedRecurringPaymentsHref(filter: PaymentPrincipalFilter): string {
  const query = new URLSearchParams({ status: "active" });
  setPaymentPrincipalParams(query, filter, RECURRING_ACTIVATED_BY_PARAMS);
  return `${PAYMENT_RECURRING_HREF}?${query.toString()}`;
}

/**
 * The Requests list showing the open payment requests a principal created, which stay payable
 * after the key is revoked or the member removed.
 *
 * @param filter - The principal.
 * @returns A project-less dashboard path.
 */
export function linkedPaymentRequestsHref(filter: PaymentPrincipalFilter): string {
  const query = new URLSearchParams({ status: "awaiting_payment" });
  setPaymentPrincipalParams(query, filter, PAYMENT_REQUEST_CREATED_BY_PARAMS);
  return `${PAYMENT_REQUESTS_HREF}?${query.toString()}`;
}
