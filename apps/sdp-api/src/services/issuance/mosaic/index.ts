/**
 * Mosaic service factory.
 *
 * Domain logic lives in `@sdp/issuance`; this module wires the app's
 * fee-payment adapter and AppError mapping into that service.
 */

import { MosaicService } from "@sdp/issuance/mosaic/service";
import { createFeePaymentAdapter } from "@sdp/payments/fee-payment";
import type { TransactionSigner } from "@solana/kit";
import { transactionFailed } from "@/lib/errors";
import type { Env } from "@/types/env";

export type MosaicFeePayment = "sponsored" | "wallet";

/**
 * Create a MosaicService with a signer and an explicit fee-payment mode.
 *
 * This is the primary factory function for creating token issuance services.
 * Use this instead of createToken2022Service for template-based tokens.
 *
 * @param env - Environment bindings
 * @param signer - Transaction signer (from SigningService.getTransactionSigner)
 * @param feePayment - "sponsored" routes fees through the Kora relay when
 * KORA_RPC_URL is configured (gasless for the custody wallet) and degrades to
 * signer-paid fees when it is not; "wallet" always makes the signer pay
 * transaction fees from its own SOL.
 */
export function createMosaicService(
  env: Env,
  signer: TransactionSigner,
  feePayment: MosaicFeePayment
): MosaicService {
  const sponsor =
    feePayment === "sponsored" && env.KORA_RPC_URL ? createFeePaymentAdapter(env) : undefined;
  return new MosaicService(env, signer, sponsor, {
    // Keep on-chain failures surfacing as AppError("TRANSACTION_FAILED") so
    // the app's error handler maps them to 400 responses.
    transactionFailedError: transactionFailed,
  });
}
