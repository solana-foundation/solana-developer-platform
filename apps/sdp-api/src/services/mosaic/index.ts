/**
 * Mosaic Service (compat shim)
 *
 * Domain logic moved to `@sdp/issuance`; this shim re-exports it so existing
 * `@/services/mosaic` imports keep working, and keeps the app-wired factory
 * (fee-payment adapter + AppError mapping) here.
 */

export * from "@sdp/issuance/mosaic";

import { MosaicService } from "@sdp/issuance/mosaic/service";
import type { TransactionSigner } from "@solana/kit";
import { transactionFailed } from "@/lib/errors";
import { createFeePaymentAdapter } from "@/services/adapters/fee-payment";
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
