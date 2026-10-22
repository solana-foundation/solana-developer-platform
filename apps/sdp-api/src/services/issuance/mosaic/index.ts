/**
 * Mosaic service factory.
 *
 * Domain logic lives in `@sdp/issuance`; this module wires the app's
 * fee-payment adapter and AppError mapping into that service.
 */

import { MosaicService } from "@sdp/issuance/mosaic/service";
import type { MovementId } from "@sdp/types/movements";
import type { TransactionSigner } from "@solana/kit";
import { badRequest, transactionFailed } from "@/lib/errors";
import { createIssuanceSponsor } from "@/services/issuance/sponsored-submitter";
import { isKoraSponsorshipConfigured, type SponsorshipScope } from "@/services/sponsorship.service";
import type { Env } from "@/types/env";

export type MosaicFeePayment = "sponsored" | "wallet";

/** How a Mosaic service pays fees: the signer's own SOL, or a sponsor for a scope and movement. */
export type MosaicFee =
  | { mode: "wallet" }
  | {
      mode: "sponsored";
      scope: SponsorshipScope;
      movement: MovementId;
      /** The custody wallet that signs; the sponsor decides the principal's scope on it. */
      custodyWalletId: string;
    };

/**
 * Create a MosaicService with a signer and an explicit fee-payment mode.
 *
 * This is the primary factory function for creating token issuance services.
 * Use this instead of createToken2022Service for template-based tokens.
 *
 * @param env - Environment bindings
 * @param signer - Transaction signer (from SigningService.getTransactionSigner)
 * @param fee - "sponsored" routes fees through the Kora relay when a Kora is configured for the
 * scope's cluster (gasless for the custody wallet) and degrades to signer-paid fees when it is
 * not; "wallet" always makes the signer pay transaction fees from its own SOL.
 * @returns The Mosaic service.
 */
export function createMosaicService(
  env: Env,
  signer: TransactionSigner,
  fee: MosaicFee
): MosaicService {
  const sponsor =
    fee.mode === "sponsored" && isKoraSponsorshipConfigured(env)
      ? createIssuanceSponsor(env, fee.scope, fee.movement, {
          custodyWalletId: fee.custodyWalletId,
        })
      : undefined;
  return new MosaicService(env, signer, sponsor, {
    // Keep on-chain failures surfacing as AppError("TRANSACTION_FAILED") so
    // the app's error handler maps them to 400 responses.
    transactionFailedError: transactionFailed,
    invalidArgumentError: badRequest,
  });
}
