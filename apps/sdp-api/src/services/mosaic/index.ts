/**
 * Mosaic Service
 *
 * Template-based token issuance using @solana/mosaic-sdk.
 * Replaces manual Token-2022 transaction building with Mosaic's
 * pre-configured templates and on-chain ABL integration.
 */

export { deriveAblListAddress, MosaicService, PACKET_DATA_SIZE } from "./service";
export * from "./types";
export { bigIntReplacer, safeStringify } from "./utils";

import type { TransactionSigner } from "@solana/kit";
import { createFeePaymentAdapter } from "@/services/adapters/fee-payment";
import type { Env } from "@/types/env";
import { MosaicService } from "./service";

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
  return new MosaicService(env, signer, sponsor);
}
