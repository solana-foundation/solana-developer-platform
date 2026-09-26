/**
 * Modeled native-SOL cost of an issuance metadata update (APE-831).
 *
 * `PATCH /v1/issuance/tokens/:tokenId` executes a Token-2022 metadata
 * transaction that spends the fee payer's SOL for the network fee and any
 * metadata-growth rent, while the policy candidate it is gated by used to
 * carry no amount — so real amount/velocity rules for SOL abstained. This
 * module models that cost before policy evaluation, using the same fee-payer
 * mode execution will use: the Kora sponsor when configured (the custody
 * wallet spends nothing), otherwise the custody signer itself.
 */

import { assertValidAddress } from "@sdp/solana/address";
import { formatDecimalAmount } from "@sdp/solana/amount";
import { type Address, createNoopSigner, type TransactionSigner } from "@solana/kit";
import { AppError } from "@/lib/errors";
import { createMosaicService } from "@/services/issuance/mosaic";
import type { Env } from "@/types/env";

/** SOL mint decimals: the modeled lamports are presented as a decimal SOL string. */
const SOL_DECIMALS = 9;

export type MetadataUpdateFeePayerMode = "sponsor" | "custody_signer";

export interface MetadataUpdateFeeModel {
  /** Modeled custody-wallet outflow as a decimal SOL string ("0" when nothing is spent). */
  amount: string;
  /** The fee-payer mode execution will use. */
  feePayer: MetadataUpdateFeePayerMode;
  /** Modeled network-fee component, in lamports (0 when the sponsor pays). */
  networkFeeLamports: bigint;
  /** Modeled metadata-growth-rent component, in lamports (0 when the sponsor pays). */
  additionalRentLamports: bigint;
}

function zeroCustodyCost(feePayer: MetadataUpdateFeePayerMode): MetadataUpdateFeeModel {
  return {
    amount: formatDecimalAmount(0n, SOL_DECIMALS),
    feePayer,
    networkFeeLamports: 0n,
    additionalRentLamports: 0n,
  };
}

/**
 * Model the native SOL a metadata update spends from the custody wallet before
 * the operation is judged by policy.
 *
 * Sponsored mode needs no on-chain read: execution swaps the Kora fee payer
 * in (which funds both the network fee and the rent transfer), so the custody
 * wallet's outflow is exactly zero. Signer-paid mode estimates the real cost
 * from the same builder execution uses, so the model cannot drift from the
 * generated instructions. A patch that changes nothing on-chain submits no
 * transaction and models as zero.
 *
 * Any failure to model throws: an unmodeled cost must never evaluate as a
 * zero-SOL operation.
 *
 * @param params - The request env, the token's mint and metadata-authority
 * addresses, and the on-chain metadata patch the handler will apply.
 * @returns The modeled SOL amount and its fee-payer mode.
 */
export async function modelMetadataUpdateSolCost(params: {
  env: Env;
  mintAddress: string;
  authorityAddress: string;
  patch: {
    name?: string;
    description?: string | null;
    uri?: string | null;
    imageUrl?: string | null;
  };
}): Promise<MetadataUpdateFeeModel> {
  // createMosaicService swaps in the Kora fee payer only when the sponsor is
  // configured; the metadata-update route always requests sponsored mode.
  if (params.env.KORA_RPC_URL) {
    return zeroCustodyCost("sponsor");
  }

  const mint = assertValidAddress(params.mintAddress, "mintAddress");
  const feePayerSigner: TransactionSigner = createNoopSigner(
    assertValidAddress(params.authorityAddress, "authorityAddress") as Address
  );
  const mosaic = createMosaicService(params.env, feePayerSigner, "wallet");

  let networkFeeLamports: bigint;
  let additionalRentLamports: bigint;
  try {
    const estimate = await mosaic.estimateUpdateMetadataSOLCost({
      mint,
      ...params.patch,
      updateAuthority: feePayerSigner,
      feePayer: feePayerSigner,
    });
    if (estimate === null) {
      // Nothing changes on-chain: execution submits no transaction.
      return zeroCustodyCost("custody_signer");
    }
    networkFeeLamports = estimate.networkFeeLamports;
    additionalRentLamports = estimate.additionalRentLamports;
  } catch (error) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Issuance metadata update could not model its SOL cost for policy evaluation",
      { reason: error instanceof Error ? error.message : String(error) }
    );
  }

  return {
    amount: formatDecimalAmount(networkFeeLamports + additionalRentLamports, SOL_DECIMALS),
    feePayer: "custody_signer",
    networkFeeLamports,
    additionalRentLamports,
  };
}
