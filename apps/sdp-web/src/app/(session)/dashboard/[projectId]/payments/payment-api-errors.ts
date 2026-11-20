import { z } from "zod";

/**
 * The error envelope sdp-api and the dashboard routes answer with, as
 * `getPaymentApiError` reads it. A message of the wrong type reads as absent.
 */
export const paymentApiErrorBodySchema = z.object({
  error: z
    .object({ message: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

export type PaymentApiErrorBody = z.infer<typeof paymentApiErrorBodySchema>;

/** The message to show for a failed payments API call. */
export function getPaymentApiError(body: unknown, fallback: string): string {
  const parsed = paymentApiErrorBodySchema.safeParse(body);
  const message = parsed.success ? parsed.data.error?.message : undefined;
  return message ? message : fallback;
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
