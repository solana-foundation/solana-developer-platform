import { currentClusterScope } from "@sdp/rpc/scope";
import { assertValidAddress } from "@sdp/solana/address";
import { getSdpDocsOrigin } from "@sdp/types/site";
import { encodeURL } from "@solana/pay";
import type { Context } from "hono";
import { badRequest, rateLimited } from "@/lib/errors";
import { assertMoneyStartAdmitted } from "@/lib/money-admission";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { resolveTokenLabel } from "@/routes/payments/token-accounts";
import { issuePaymentRequestTransaction } from "@/services/payments/payment-request-sponsorship";
import {
  isPaymentRequestExpired,
  reconcilePaymentRequest,
} from "@/services/payments/payment-requests";
import type { Env } from "@/types/env";
import { findPaymentRequest } from "./context";
import type { transactionRequestBodySchema } from "./schemas";

const REQUEST_LABEL = "Solana Developer Platform";
const REQUEST_ICON = `${getSdpDocsOrigin()}/icon.svg`;

/**
 * The public view of a payment request, with the Solana Pay transaction-request link while it
 * can still be paid.
 *
 * @param c - The request context, under `paymentRequestScope`.
 * @returns The request's amount, token, recipient, status, and Solana Pay URL.
 */
export async function getPaymentRequest(c: Context<{ Bindings: Env }, "/:token">) {
  const request = await findPaymentRequest(c.env, c.req.param("token"));

  const expired = isPaymentRequestExpired(request.expires_at);
  const status = expired && request.status === "awaiting_payment" ? "expired" : request.status;
  const payable = status === "awaiting_payment" && request.custody_wallet_id !== null;

  let solanaPayUrl: string | null = null;
  if (payable) {
    const link = new URL(`/pay/${c.req.param("token")}/tx`, c.req.url);
    link.protocol = "https:";
    solanaPayUrl = encodeURL({ link }).toString();
  }

  return c.json({
    amount: request.amount,
    token: request.token,
    tokenSymbol: resolveTokenLabel(request.token),
    recipient: request.destination_address,
    reference: request.reference,
    status,
    expiresAt: request.expires_at,
    network: currentClusterScope().cluster,
    solanaPayUrl,
  });
}

/**
 * The Solana Pay transaction-request metadata a wallet shows before it posts its account.
 *
 * @param c - The request context.
 * @returns The label and icon.
 */
export function getTransactionMetadata(c: Context<{ Bindings: Env }, "/:token/tx">) {
  return c.json({ label: REQUEST_LABEL, icon: REQUEST_ICON });
}

/**
 * The Solana Pay transaction request: the fee-sponsored transfer the posting wallet signs.
 *
 * @param c - The request context, under `paymentRequestScope` with a validated body.
 * @returns The partially signed transaction and the message the wallet shows.
 * @throws AppError `BAD_REQUEST` when the request is no longer payable.
 * @throws AppError `RATE_LIMITED`, with `Retry-After`, while another payer's claim is live.
 */
export async function createSponsoredTransaction(
  c: ValidatedBodyContext<typeof transactionRequestBodySchema>
) {
  const { token } = c.req.param();
  const existing = await findPaymentRequest(c.env, token);
  const request = await reconcilePaymentRequest(c.env, existing, (seconds) =>
    c.header("Retry-After", String(seconds))
  );
  if (request.status !== "awaiting_payment" || isPaymentRequestExpired(request.expires_at)) {
    throw badRequest("Payment request is no longer payable");
  }
  if (!request.project_id) {
    throw badRequest("Payment request is not eligible for sponsored fees");
  }
  // `/pay` sponsors without an authenticated actor, so it admits the money
  // movement itself: a production request stops being sponsored once its
  // organization loses the production entitlement (APE-351), and a deleted
  // organization's requests stop being sponsored at all (HOO-1955).
  await assertMoneyStartAdmitted(
    c.env,
    { organizationId: request.organization_id, projectId: request.project_id },
    { surface: "http", movement: "payments.pay_request", subjectId: request.id },
    { custodyWalletId: null }
  );

  const sponsored = await issuePaymentRequestTransaction(c, {
    request: { ...request, project_id: request.project_id },
    payer: assertValidAddress(c.req.valid("json").account, "account"),
    recipient: assertValidAddress(request.destination_address, "destinationAddress"),
    reference: assertValidAddress(request.reference, "reference"),
  });
  if (sponsored.kind === "held") {
    c.header("Retry-After", String(sponsored.retryAfterSeconds));
    throw rateLimited("Another payer holds this payment request's sponsored transaction");
  }
  return c.json({
    transaction: sponsored.transaction,
    message: `Pay ${request.amount} ${resolveTokenLabel(request.token)} to ${REQUEST_LABEL}`,
  });
}
