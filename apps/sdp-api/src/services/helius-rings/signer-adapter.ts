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
 * Signs the gateway-built outer transaction with the custody wallet resolved by
 * `owner`'s public key: a signature from any other key moves the wrong wallet's
 * money. The bytes are never logged; they can carry unmodelled routing metadata.
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
  /** Base58 address of the wallet the transaction requires a signature from. */
  owner: string;
  unsignedTxBase64: string;
  /** Test seam; production resolves the owner's custody signer. */
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

  // The decoder returns an unbranded Transaction; the gateway built these bytes
  // as the complete compiled tx the signer brands assert.
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
 * The signer for exactly the owner named, or a non-retryable refusal. Neither
 * failure falls back: signing anyway would produce a valid signature from the
 * wrong key.
 */
async function resolveOwnerSigner(
  input: Pick<SignRingsOuterTransactionInput, "env" | "organizationId" | "projectId" | "owner">
): Promise<TransactionSigner> {
  const custody = new CustodyConfigStore(getDb(input.env), input.env);
  const wallet = await custody.findActiveWalletByPublicKey(
    input.organizationId,
    input.projectId,
    input.owner
  );
  if (!wallet) {
    throw new RingsAdapterError(
      "signer_failed",
      `custody controls no active wallet for the shielded identity's owner ${input.owner}`,
      { retryable: false }
    );
  }

  const signer = await createOrgSignerForCustodyWallet(
    input.env,
    input.organizationId,
    input.projectId,
    wallet.id
  );
  if (signer.address !== input.owner) {
    throw new RingsAdapterError(
      "signer_failed",
      `custody wallet ${wallet.id} resolved a signer for a different key than the shielded identity's owner`,
      { retryable: false }
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
