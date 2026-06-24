import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { parseDecimalAmount } from "@/lib/amount";
import { assertValidAddress } from "@/lib/solana";
import { resolveMintDecimals } from "@/routes/payments/token-accounts";
import { SOL_MINT } from "@/services/payment-operation.service";
import {
  findReference,
  type TransferValidation,
  validateNativeTransfer,
  validateTransfer,
} from "@/services/solana";
import { createRpc } from "@/services/solana/rpc";
import type { Env } from "@/types/env";

const SOL_DECIMALS = 9;

/**
 * Reconciles a single awaiting-payment request against the chain: locate the
 * payment by its reference account, verify the recipient actually received at
 * least the requested amount, and settle the request as paid. Returns the
 * settled row, or null when no valid payment has landed yet.
 *
 * The reference lookup runs first so an unpaid request costs one cheap RPC call
 * — decimals resolution and amount validation only happen once a payment exists.
 */
export async function reconcilePaymentRequest(
  env: Env,
  request: PaymentRequestRow
): Promise<PaymentRequestRow | null> {
  const rpc = createRpc(env);
  const found = await findReference(rpc, assertValidAddress(request.reference, "reference"));
  if (!found) {
    return null;
  }

  const recipient = assertValidAddress(request.destination_address, "destinationAddress");

  let validation: TransferValidation;
  if (request.token === SOL_MINT) {
    validation = await validateNativeTransfer(rpc, found.signature, {
      recipient,
      amount: parseDecimalAmount(request.amount, SOL_DECIMALS),
    });
  } else {
    const mint = assertValidAddress(request.token, "token");
    const decimals = await resolveMintDecimals(rpc, mint);
    validation = await validateTransfer(rpc, found.signature, {
      recipient,
      splToken: mint,
      amount: parseDecimalAmount(request.amount, decimals),
    });
  }

  if (!validation.valid) {
    return null;
  }

  return createPaymentRequestsRepository(env).settlePaymentRequest(request.id, "paid");
}
