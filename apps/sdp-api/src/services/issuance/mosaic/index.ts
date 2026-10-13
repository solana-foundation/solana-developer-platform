/**
 * Mosaic service factory.
 *
 * Domain logic lives in `@sdp/issuance`; this module wires the app's
 * fee-payment adapter and AppError mapping into that service.
 */

import { MosaicService } from "@sdp/issuance/mosaic/service";
import { isFeePaymentConfigured } from "@sdp/payments/fee-payment";
import { createClusterRpc } from "@sdp/rpc/factory";
import type { SolanaRpc } from "@sdp/rpc/solana";
import type { TransactionSigner } from "@solana/kit";
import type { resolveTokenAccount } from "@solana/mosaic-sdk";
import { badRequest, transactionFailed } from "@/lib/errors";
import { createSponsorshipFeePayment, type SponsorshipScope } from "@/services/sponsorship.service";
import type { Env } from "@/types/env";

export type MosaicFeePayment = "sponsored" | "wallet";

type MosaicSdkRpc = Parameters<typeof resolveTokenAccount>[0];

/**
 * The open cluster scope's RPC client, typed for the Mosaic-family SDKs
 * (`@solana/mosaic-sdk`, `@solana/token-acl-sdk`). Those SDKs still publish an
 * older Solana Kit's RPC types over a runtime-compatible client, so this is the
 * one cross-version cast at the SDK boundary.
 *
 * @returns The scope's RPC client, also typed as the Mosaic SDK's RPC.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function createMosaicSdkRpc(): SolanaRpc & MosaicSdkRpc {
  return createClusterRpc() as unknown as SolanaRpc & MosaicSdkRpc;
}

/**
 * Create a MosaicService with a signer and an explicit fee-payment mode.
 *
 * This is the primary factory function for creating token issuance services.
 * Use this instead of createToken2022Service for template-based tokens.
 *
 * @param env - Environment bindings
 * @param signer - Transaction signer (from SigningService.getTransactionSigner)
 * @param feePayment - "sponsored" routes fees through the fee payer when the
 * deployment has one for the cluster scope's cluster (gasless for the custody
 * wallet) and degrades to signer-paid fees when it does not; "wallet" always
 * makes the signer pay transaction fees from its own SOL.
 * @param sponsorshipScope - The request's sponsorship scope; required when sponsoring.
 * @returns The Mosaic service.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope when sponsoring.
 */
export function createMosaicService(
  env: Env,
  signer: TransactionSigner,
  feePayment: MosaicFeePayment,
  sponsorshipScope?: SponsorshipScope
): MosaicService {
  const sponsored = feePayment === "sponsored" && isFeePaymentConfigured(env);
  if (sponsored && !sponsorshipScope) {
    throw new Error("Sponsorship scope is required for sponsored issuance");
  }

  const sponsor =
    sponsored && sponsorshipScope ? createSponsorshipFeePayment(env, sponsorshipScope) : undefined;
  return new MosaicService(env, createMosaicSdkRpc(), signer, sponsor, {
    // Keep on-chain failures surfacing as AppError("TRANSACTION_FAILED") so
    // the app's error handler maps them to 400 responses.
    transactionFailedError: transactionFailed,
    invalidArgumentError: badRequest,
  });
}
