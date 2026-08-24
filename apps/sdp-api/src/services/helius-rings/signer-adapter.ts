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
import { getDb } from "@/db";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
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
  /**
   * The address the transaction requires a signature from — the Rings wallet's
   * owner, which is also the fee payer of every outer transaction.
   *
   * Named explicitly rather than left to the organization's default signer.
   * Rings registers an identity *to* an owner and spends *from* it, so signing
   * with whichever wallet the org config happens to default to would at best
   * be rejected for a missing signature and at worst move the wrong wallet's
   * money.
   */
  owner: string;
  unsignedTxBase64: string;
  /** Test seam; production resolves the owner's custody wallet. */
  signer?: TransactionSigner;
}

export async function signRingsOuterTransaction(
  input: SignRingsOuterTransactionInput
): Promise<string> {
  const base64 = getBase64Codec();

  let signer: TransactionSigner;
  let signed: Transaction;
  try {
    signer = input.signer ?? (await resolveOwnerSigner(input));
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

/**
 * Resolves the custody wallet holding the owner's key.
 *
 * By public key rather than by the `custody_wallet_id` recorded on the rings
 * wallet: that link is the durable audit trail, but the only thing that makes
 * a signature valid is that it comes from the key the transaction names. The
 * lookup is scoped to the organization and to active wallets, so an owner
 * custody no longer controls fails here rather than at the chain.
 */
async function resolveOwnerSigner(
  input: SignRingsOuterTransactionInput
): Promise<TransactionSigner> {
  const wallet = await new CustodyConfigStore(
    getDb(input.env),
    input.env
  ).findActiveWalletByPublicKey(input.organizationId, input.projectId, input.owner);
  if (!wallet) {
    throw new SigningError(`custody does not control ${input.owner}`, "WALLET_NOT_FOUND");
  }

  const signer = await createOrgSignerForCustodyWallet(
    input.env,
    input.organizationId,
    input.projectId,
    wallet.id
  );

  // The row was found by public key, so this should be unreachable. It is here
  // because the cost of being wrong is signing someone else's transfer, and a
  // provider that resolves a row to a different key should stop the operation
  // rather than produce a signature nobody asked for.
  if (signer.address !== input.owner) {
    throw new SigningError(
      `custody resolved ${signer.address} for owner ${input.owner}`,
      "WALLET_NOT_FOUND"
    );
  }

  return signer;
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
