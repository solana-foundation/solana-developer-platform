/**
 * Solana Service Factory
 *
 * Factory functions for creating Solana services with optional
 * fee payment provider integration (Kora for gasless transactions).
 */

import { isFeePaymentConfiguredForCluster } from "@sdp/payments/fee-payment";
import { currentClusterScope } from "@sdp/rpc/scope";
import { Token2022Service } from "@sdp/solana/token-2022";
import type { TransactionSigner } from "@solana/kit";
import { createMosaicSdkRpc } from "@/services/issuance/mosaic";
import {
  createSponsorshipFeePayment,
  createUnscopedSponsorshipFeePayment,
  type SponsorshipScope,
} from "@/services/sponsorship.service";
import type { Env } from "@/types/env";

/**
 * Create a Token2022Service with a signer, sponsored when the deployment has a fee payer for the
 * cluster scope's cluster (gasless for the custody wallet); otherwise the custody wallet pays fees
 * directly.
 *
 * @param env - Environment bindings
 * @param signer - Transaction signer (from SigningService.getTransactionSigner)
 * @param sponsorshipScope - The request's sponsorship scope; unscoped sponsorship without one.
 * @returns The Token-2022 service.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function createToken2022Service(
  env: Env,
  signer: TransactionSigner,
  sponsorshipScope?: SponsorshipScope
): Token2022Service {
  const feePayment = isFeePaymentConfiguredForCluster(env, currentClusterScope().cluster)
    ? sponsorshipScope
      ? createSponsorshipFeePayment(env, sponsorshipScope)
      : createUnscopedSponsorshipFeePayment(env)
    : undefined;

  return new Token2022Service(createMosaicSdkRpc(), signer, feePayment);
}
