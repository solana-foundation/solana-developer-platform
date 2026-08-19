import { withPolicyDenialReason } from "@/lib/policy-denial-reason";

export type PaymentApiErrorBody = {
  error?:
    | string
    | {
        message?: string;
        /**
         * A policy denial puts the rule that fired here while `message` stays
         * generic. Typed so this shape stops discarding it.
         */
        details?: {
          reason?: string;
        };
      };
  message?: string;
};

/**
 * The message to show for a failed payments API call.
 *
 * A policy denial arrives as a generic `message` plus a specific `details.reason`.
 * Reading only `message` left the payments workspace saying "Wallet operation denied
 * by policy" and nothing else — which is where people actually hit a denial, so the
 * reason has to be joined on here and not only in the custody actions.
 */
export function getPaymentApiError(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fallback;
  }

  const error = "error" in body ? body.error : undefined;
  if (typeof error === "string" && error) {
    return error;
  }
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const message = "message" in error ? error.message : undefined;
    if (typeof message === "string" && message) {
      const details = "details" in error ? error.details : undefined;
      const reason =
        typeof details === "object" &&
        details !== null &&
        !Array.isArray(details) &&
        "reason" in details &&
        typeof details.reason === "string"
          ? details.reason.trim()
          : "";
      return withPolicyDenialReason(message, reason || null);
    }
  }
  if ("message" in body && typeof body.message === "string" && body.message) {
    return body.message;
  }
  return fallback;
}

export function parsePaymentApiErrorText(body: string, fallback = body): string {
  if (!body) {
    return fallback;
  }

  try {
    return getPaymentApiError(JSON.parse(body), fallback);
  } catch {
    return body;
  }
}
