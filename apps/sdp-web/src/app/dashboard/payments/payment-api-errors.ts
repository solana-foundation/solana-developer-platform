export type PaymentApiErrorBody = {
  error?:
    | string
    | {
        message?: string;
      };
  message?: string;
};

export function getPaymentApiError(body: PaymentApiErrorBody, fallback: string): string {
  const error = body.error;
  if (typeof error === "string" && error) {
    return error;
  }
  if (typeof error === "object" && typeof error.message === "string" && error.message) {
    return error.message;
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
