/**
 * Solana Service Factory
 *
 * Factory functions for creating Solana services with optional
 * fee payment provider integration (Kora for gasless transactions).
 */

import { resolveKoraEndpoint } from "@sdp/fee-payment";
import { Token2022Service } from "@sdp/solana/token-2022";
import type { TransactionSigner } from "@solana/kit";
import { createSponsorshipFeePayment, type SponsorshipScope } from "@/services/sponsorship.service";
import type { Env } from "@/types/env";

/**
 * Create a Token2022Service with a signer and optional Kora fee payment integration.
 *
 * @param env - Environment bindings
 * @param signer - Transaction signer (from SigningService.getTransactionSigner)
 *
 * When a Kora is configured for the scope's cluster (`KORA_<CLUSTER>_URL`),
 * the service uses it to pay transaction fees (gasless for the custody
 * wallet). Otherwise, the custody wallet pays fees directly.
 */
export function createToken2022Service(
  env: Env,
  signer: TransactionSigner,
  sponsorshipScope: SponsorshipScope
): Token2022Service {
  const feePayment =
    resolveKoraEndpoint(env, sponsorshipScope.cluster) === null
      ? undefined
      : createSponsorshipFeePayment(env, sponsorshipScope);

  return new Token2022Service(env, signer, feePayment);
}
