/**
 * Solana Service Factory
 *
 * Factory functions for creating Solana services with optional
 * fee payment provider integration (Kora for gasless transactions).
 */

import { createFeePaymentAdapter } from "@/services/adapters/fee-payment";
import type { Env } from "@/types/env";
import { Token2022Service } from "./token-2022";

/**
 * Create a Token2022Service with optional Kora fee payment integration.
 *
 * When KORA_RPC_URL is set in the environment, the service will use Kora
 * to pay transaction fees (gasless for the custody wallet). Otherwise,
 * the custody wallet pays fees directly.
 */
export function createToken2022Service(env: Env): Token2022Service {
  // Only create fee payment adapter if Kora is configured
  const feePayment = env.KORA_RPC_URL ? createFeePaymentAdapter(env) : undefined;

  return new Token2022Service(env, feePayment);
}
