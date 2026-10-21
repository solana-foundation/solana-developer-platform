import { currentClusterScope } from "@sdp/rpc/scope";
import { assertValidAddress } from "@sdp/solana/address";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { encodeURL } from "@solana/pay";
import type { Context } from "hono";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { internalError } from "@/lib/errors";
import { checkMoneyStart } from "@/lib/money-admission";
import { resolveTokenLabel } from "@/routes/payments/token-accounts";
import {
  isPaymentRequestExpired,
  reconcilePaymentRequest,
} from "@/services/payments/payment-requests";
import type { Env } from "@/types/env";
import { findPaymentRequest } from "./context";

const REQUEST_LABEL = "Solana Developer Platform";

/**
 * The Solana Pay transfer-request URL for an open payment request. The payer's wallet builds,
 * signs, and pays the fees for the transfer itself; SDP signs nothing.
 *
 * @param request - The payment request, open and admitted.
 * @param tokenSymbol - The token's display label for the wallet's message.
 * @returns The `solana:` URL.
 */
function transferRequestUrl(request: PaymentRequestRow, tokenSymbol: string): string {
  const url = encodeURL({
    recipient: assertValidAddress(request.destination_address, "destinationAddress"),
    reference: assertValidAddress(request.reference, "reference"),
    label: REQUEST_LABEL,
    message: `Pay ${request.amount} ${tokenSymbol} to ${REQUEST_LABEL}`,
    splToken: request.token === SOL_MINT ? undefined : assertValidAddress(request.token, "token"),
  });
  // The stored decimal string, not encodeURL's float `amount`, so the link asks for exactly the
  // requested amount.
  url.searchParams.set("amount", request.amount);
  return url.toString();
}

/**
 * Whether the request's organization may still take payment against it: a deleted organization,
 * or a production request whose organization lost the production entitlement, stops advertising a
 * payable link (HOO-1955, APE-351).
 *
 * @param env - Worker bindings.
 * @param request - The payment request.
 * @returns Whether the money start is admitted.
 * @throws AppError `INTERNAL_ERROR` when the request has no Project.
 */
async function isPaymentAdmitted(env: Env, request: PaymentRequestRow): Promise<boolean> {
  if (request.project_id === null) {
    throw internalError("payment_requests row is missing project_id");
  }
  const decision = await checkMoneyStart(
    env,
    { organizationId: request.organization_id, projectId: request.project_id },
    { surface: "http", movement: "payments.pay_request", subjectId: request.id },
    { custodyWalletId: null }
  );
  return decision.admitted;
}

/**
 * The public view of a payment request, with the Solana Pay transfer-request link while it can
 * still be paid.
 *
 * @param c - The request context, under `paymentRequestScope`.
 * @returns The request's amount, token, recipient, status, and Solana Pay URL.
 */
export async function getPaymentRequest(c: Context<{ Bindings: Env }, "/:token">) {
  const existing = await findPaymentRequest(c.env, c.req.param("token"));
  const request = await reconcilePaymentRequest(c.env, existing, { bestEffort: true });

  const expired = isPaymentRequestExpired(request.expires_at);
  const status = expired && request.status === "awaiting_payment" ? "expired" : request.status;
  const tokenSymbol = resolveTokenLabel(request.token);
  const payable =
    status === "awaiting_payment" &&
    request.custody_wallet_id !== null &&
    (await isPaymentAdmitted(c.env, request));

  return c.json({
    amount: request.amount,
    token: request.token,
    tokenSymbol,
    recipient: request.destination_address,
    reference: request.reference,
    status,
    expiresAt: request.expires_at,
    network: currentClusterScope().cluster,
    solanaPayUrl: payable ? transferRequestUrl(request, tokenSymbol) : null,
  });
}
