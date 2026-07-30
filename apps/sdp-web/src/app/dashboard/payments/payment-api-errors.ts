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
export function getPaymentApiError(body: PaymentApiErrorBody, fallback: string): string {
  const error = body.error;
  if (typeof error === "string" && error) {
    return error;
  }
  if (typeof error === "object" && typeof error.message === "string" && error.message) {
    const reason = typeof error.details?.reason === "string" ? error.details.reason.trim() : "";
    return withPolicyDenialReason(error.message, reason || null);
  }
  if (typeof body.message === "string" && body.message) {
    return body.message;
  }
  return fallback;
}

export function parsePaymentApiErrorText(body: string, fallback = body): string {
  if (!body) {
    return fallback;
  }

  try {
    return getPaymentApiError(JSON.parse(body) as PaymentApiErrorBody, fallback);
  } catch {
    return body;
  }
}
