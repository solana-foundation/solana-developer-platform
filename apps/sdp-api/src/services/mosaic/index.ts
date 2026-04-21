/**
 * Mosaic Service
 *
 * Template-based token issuance using @solana/mosaic-sdk.
 * Replaces manual Token-2022 transaction building with Mosaic's
 * pre-configured templates and on-chain ABL integration.
 */

export { MosaicService } from "./service";
export * from "./types";
export { bigIntReplacer, safeStringify } from "./utils";

import type { TransactionSigner } from "@solana/kit";
import { createFeePaymentAdapter } from "@/services/adapters/fee-payment";
import type { Env } from "@/types/env";
import { MosaicService } from "./service";

/**
 * Create a MosaicService with a signer and optional Kora fee payment integration.
 *
 * This is the primary factory function for creating token issuance services.
 * Use this instead of createToken2022Service for template-based tokens.
 *
 * @param env - Environment bindings
 * @param signer - Transaction signer (from SigningService.getTransactionSigner)
 *
 * When KORA_RPC_URL is set in the environment, the service will use Kora
 * to pay transaction fees (gasless for the custody wallet).
 */
export function createMosaicService(env: Env, signer: TransactionSigner): MosaicService {
  const feePayment = env.KORA_RPC_URL ? createFeePaymentAdapter(env) : undefined;
  return new MosaicService(env, signer, feePayment);
}
