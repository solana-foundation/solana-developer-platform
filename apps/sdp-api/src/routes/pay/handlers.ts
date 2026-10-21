import { currentClusterScope } from "@sdp/rpc/scope";
import { assertValidAddress } from "@sdp/solana/address";
import { getSdpDocsOrigin } from "@sdp/types/site";
import { encodeURL } from "@solana/pay";
import type { Context } from "hono";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { badRequest, conflict, internalError } from "@/lib/errors";
import { assertMoneyStartAdmitted, checkMoneyStart } from "@/lib/money-admission";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { resolveTokenLabel } from "@/routes/payments/token-accounts";
import { buildPaymentRequestTransaction } from "@/services/payments/payment-request-transaction";
import {
  hasPaymentInFlight,
  isPaymentRequestExpired,
  reconcilePaymentRequest,
} from "@/services/payments/payment-requests";
import type { Env } from "@/types/env";
import { findPaymentRequest } from "./context";
import type { transactionRequestBodySchema } from "./schemas";

const REQUEST_LABEL = "Solana Developer Platform";
const REQUEST_ICON = `${getSdpDocsOrigin()}/icon.svg`;

/**
 * The money start a `/pay` link makes for its request: admitted while the request is open and
 * its organization may still take payment, refused for a deleted organization or a production
 * request whose organization lost the production entitlement (HOO-1955, APE-351).
 *
 * @param request - The payment request.
 * @returns The admission scope, context and subject for the money-admission check.
 * @throws AppError `INTERNAL_ERROR` when the request has no Project.
 */
function paymentRequestMoneyStart(request: PaymentRequestRow) {
  if (request.project_id === null) {
    throw internalError("payment_requests row is missing project_id");
  }
  return [
    { organizationId: request.organization_id, projectId: request.project_id },
    { surface: "http", movement: "payments.pay_request", subjectId: request.id },
    { custodyWalletId: null },
  ] as const;
}

/**
 * Whether a reconciled payment request still takes payment: awaiting it, unexpired, and landing
 * in a custody wallet.
 *
 * @param request - The reconciled payment request.
 * @returns Whether the request is open for payment.
 */
function isOpenForPayment(request: PaymentRequestRow): boolean {
  return (
    request.status === "awaiting_payment" &&
    !isPaymentRequestExpired(request.expires_at) &&
    request.custody_wallet_id !== null
  );
}

/**
 * Whether the link may offer a transaction: the request is open and its money start admitted.
 *
 * @param env - Worker bindings.
 * @param request - The reconciled payment request.
 * @returns Whether the request can be paid now.
 */
async function isPayable(env: Env, request: PaymentRequestRow): Promise<boolean> {
  if (!isOpenForPayment(request)) {
    return false;
  }
  const decision = await checkMoneyStart(env, ...paymentRequestMoneyStart(request));
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
  let solanaPayUrl: string | null = null;
  if (await isPayable(c.env, request)) {
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
 * The Solana Pay transaction request: the unsigned transfer the posting wallet signs and pays
 * the fees for, built on the request's own cluster.
 *
 * @param c - The request context, under `paymentRequestScope` with a validated body.
 * @returns The unsigned transaction and the message the wallet shows.
 * @throws AppError `BAD_REQUEST` when the request is no longer payable.
 * @throws MoneyMovementRefusedError when the organization may no longer take payment.
 * @throws AppError `CONFLICT` when a payment for the request is already confirmed on chain.
 */
export async function createPaymentTransaction(
  c: ValidatedBodyContext<typeof transactionRequestBodySchema>
) {
  const { token } = c.req.param();
  const existing = await findPaymentRequest(c.env, token);
  const request = await reconcilePaymentRequest(c.env, existing, { bestEffort: false });
  if (!isOpenForPayment(request)) {
    throw badRequest("Payment request is no longer payable");
  }
  await assertMoneyStartAdmitted(c.env, ...paymentRequestMoneyStart(request));
  // NOTE: Known race-condition: two payers who both build before either payment confirms can
  // both pay. The first to finalize settles the request; the second lands in the wallet as an
  // unlinked inbound payment, visible in its observed activity, and is refunded by hand.
  if (await hasPaymentInFlight(request)) {
    throw conflict("A payment for this request is already on its way");
  }

  const transaction = await buildPaymentRequestTransaction({
    request,
    payer: assertValidAddress(c.req.valid("json").account, "account"),
  });
  return c.json({
    transaction,
    message: `Pay ${request.amount} ${resolveTokenLabel(request.token)} to ${REQUEST_LABEL}`,
  });
}
