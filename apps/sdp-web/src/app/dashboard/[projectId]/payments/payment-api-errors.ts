export type PaymentApiErrorBody = {
  error?:
    | string
    | {
        message?: string;
      };
  message?: string;
};

/** The message to show for a failed payments API call. */
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
      return message;
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
