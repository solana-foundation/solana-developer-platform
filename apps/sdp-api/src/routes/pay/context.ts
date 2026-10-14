import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createSystemPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { notFound } from "@/lib/errors";
import type { Env } from "@/types/env";

/**
 * The payment request a public `/pay` link names.
 *
 * @param env - Worker bindings.
 * @param token - The link's public token.
 * @returns The payment request row.
 * @throws AppError `NOT_FOUND` when no request has that token.
 */
export async function findPaymentRequest(env: Env, token: string): Promise<PaymentRequestRow> {
  const row =
    await createSystemPaymentRequestsRepository(env).getPaymentRequestByPublicToken(token);
  if (!row) {
    throw notFound("Payment request");
  }
  return row;
}
