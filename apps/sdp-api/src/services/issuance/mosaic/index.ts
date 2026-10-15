/**
 * Mosaic service factory.
 *
 * Domain logic lives in `@sdp/issuance`; this module wires the app's
 * fee-payment adapter and AppError mapping into that service.
 */

import { resolveKoraEndpoint } from "@sdp/fee-payment";
import { MosaicService } from "@sdp/issuance/mosaic/service";
import { CLUSTER_BY_SDP_ENVIRONMENT, type MovementId } from "@sdp/types";
import type { TransactionSigner } from "@solana/kit";
import { badRequest, transactionFailed } from "@/lib/errors";
import { createSponsorshipFeePayment, type SponsorshipScope } from "@/services/sponsorship.service";
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
 * a Kora is configured for the scope's cluster (gasless for the custody wallet) and degrades to
 * signer-paid fees when it is not; "wallet" always makes the signer pay
 * transaction fees from its own SOL.
 * @param sponsorship - Who is sponsored and the movement the sponsor serves; required when
 * `feePayment` is "sponsored".
 * @returns The Mosaic service.
 */
export function createMosaicService(
  env: Env,
  signer: TransactionSigner,
  feePayment: MosaicFeePayment,
  sponsorship?: { scope: SponsorshipScope; movement: MovementId }
): MosaicService {
  if (feePayment === "sponsored" && !sponsorship) {
    throw new Error("Sponsorship scope is required for sponsored issuance");
  }

  const sponsor =
    feePayment === "sponsored" &&
    sponsorship &&
    resolveKoraEndpoint(env, CLUSTER_BY_SDP_ENVIRONMENT[sponsorship.scope.environment]) !== null
      ? createSponsorshipFeePayment(env, sponsorship.scope, sponsorship.movement)
      : undefined;
  return new MosaicService(env, signer, sponsor, {
    // Keep on-chain failures surfacing as AppError("TRANSACTION_FAILED") so
    // the app's error handler maps them to 400 responses.
    transactionFailedError: transactionFailed,
    invalidArgumentError: badRequest,
  });
}
