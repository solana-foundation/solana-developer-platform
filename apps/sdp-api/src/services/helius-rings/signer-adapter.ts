import { SigningError } from "@sdp/custody/signing";
import { getBase64Codec } from "@solana/codecs";
import {
  getTransactionDecoder,
  getTransactionEncoder,
  type Transaction,
  type TransactionWithinSizeLimit,
  type TransactionWithLifetime,
} from "@solana/kit";
import {
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  type TransactionSigner,
} from "@solana/signers";
import { createOrgSigner } from "@/services/solana/signer";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";

/**
 * Signs the gateway-built outer transaction with the SDP custody signer.
 * Base64 bytes in, base64 bytes out — no SecretRef crosses this boundary, and
 * the transaction bytes are never logged here (they can carry routing
 * metadata the redaction registry does not model).
 */

/** Signer errors that a retry cannot fix. */
const NON_RETRYABLE_SIGNING_CODES = new Set([
  "PROVIDER_NOT_CONFIGURED",
  "WALLET_NOT_FOUND",
  "NOT_FOUND",
  "INVALID_REQUEST",
  "APPROVAL_REJECTED",
]);

export interface SignRingsOuterTransactionInput {
  env: Env;
  organizationId: string;
  projectId: string;
  unsignedTxBase64: string;
  /** Test seam; production resolves the org signer. */
  signer?: TransactionSigner;
}

export async function signRingsOuterTransaction(
  input: SignRingsOuterTransactionInput
): Promise<string> {
  const base64 = getBase64Codec();

  let signer: TransactionSigner;
  let signed: Transaction;
  try {
    signer =
      input.signer ?? (await createOrgSigner(input.env, input.organizationId, input.projectId));
  } catch (error) {
    throw toSignerFailure(error);
  }

  // The decoder returns an unbranded Transaction; the gateway built these
  // bytes as a complete compiled tx, which is what the signer brands assert.
  const transaction = getTransactionDecoder().decode(
    base64.encode(input.unsignedTxBase64)
  ) as Transaction & TransactionWithinSizeLimit & TransactionWithLifetime;

  try {
    if (isTransactionModifyingSigner(signer)) {
      [signed] = await signer.modifyAndSignTransactions([transaction]);
    } else if (isTransactionPartialSigner(signer)) {
      const [signatures] = await signer.signTransactions([transaction]);
      signed = { ...transaction, signatures: { ...transaction.signatures, ...signatures } };
    } else {
      throw new RingsAdapterError(
        "signer_failed",
        "custody signer cannot sign compiled transactions",
        { retryable: false }
      );
    }
  } catch (error) {
    throw toSignerFailure(error);
  }

  return base64.decode(getTransactionEncoder().encode(signed));
}

function toSignerFailure(error: unknown): RingsAdapterError {
  if (error instanceof RingsAdapterError) return error;
  if (error instanceof SigningError) {
    return new RingsAdapterError("signer_failed", error.message, {
      retryable: !NON_RETRYABLE_SIGNING_CODES.has(error.code),
      cause: error,
    });
  }
  return new RingsAdapterError("signer_failed", "custody signing failed", {
    retryable: true,
    cause: error,
  });
}
