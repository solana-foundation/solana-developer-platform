/**
 * Solana Service Factory
 *
 * Factory functions for creating Solana services with optional
 * fee payment provider integration (Kora for gasless transactions).
 */

import { createFeePaymentAdapter } from "@sdp/payments/fee-payment";
import { Token2022Service } from "@sdp/solana/token-2022";
import type { TransactionSigner } from "@solana/kit";
import type { Env } from "@/types/env";

/**
 * Create a Token2022Service with a signer and optional Kora fee payment integration.
 *
 * @param env - Environment bindings
 * @param signer - Transaction signer (from SigningService.getTransactionSigner)
 *
 * When KORA_RPC_URL is set in the environment, the service will use Kora
 * to pay transaction fees (gasless for the custody wallet). Otherwise,
 * the custody wallet pays fees directly.
 */
export function createToken2022Service(env: Env, signer: TransactionSigner): Token2022Service {
  // Only create fee payment adapter if Kora is configured
  const feePayment = env.KORA_RPC_URL ? createFeePaymentAdapter(env) : undefined;

  return new Token2022Service(env, signer, feePayment);
}
