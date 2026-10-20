/**
 * Solana Service Factory
 *
 * Factory functions for creating Solana services with optional
 * fee payment provider integration (Kora for gasless transactions).
 */

import { Token2022Service } from "@sdp/solana/token-2022";
import type { MovementId } from "@sdp/types/movements";
import type { TransactionSigner } from "@solana/kit";
import { createIssuanceSponsor } from "@/services/issuance/sponsored-submitter";
import { isKoraSponsorshipConfigured, type SponsorshipScope } from "@/services/sponsorship.service";
import type { Env } from "@/types/env";

/**
 * Create a Token2022Service with a signer and optional Kora fee payment integration.
 *
 * @param env - Environment bindings
 * @param signer - Transaction signer (from SigningService.getTransactionSigner)
 * @param sponsorship - Who is sponsored and the movement the sponsor serves.
 * @param sponsorship.scope - Who is sponsored.
 * @param sponsorship.movement - The movement the sponsor serves.
 * @returns The Token-2022 service.
 *
 * When a Kora is configured for the scope's cluster (`KORA_<CLUSTER>_URL`),
 * the service uses it to pay transaction fees (gasless for the custody
 * wallet). Otherwise, the custody wallet pays fees directly.
 */
export function createToken2022Service(
  env: Env,
  signer: TransactionSigner,
  sponsorship: { scope: SponsorshipScope; movement: MovementId }
): Token2022Service {
  const feePayment = isKoraSponsorshipConfigured(env)
    ? createIssuanceSponsor(env, sponsorship.scope, sponsorship.movement)
    : undefined;

  return new Token2022Service(env, signer, feePayment);
}
