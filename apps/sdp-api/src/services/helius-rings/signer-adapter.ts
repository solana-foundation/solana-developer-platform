import { SigningError } from "@sdp/custody/signing";
import { getBase64Codec } from "@solana/codecs";
import {
  address,
  getAddressEncoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  signatureBytes,
  type Transaction,
  type TransactionWithinSizeLimit,
  type TransactionWithLifetime,
  verifySignature,
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

export interface AssertRingsSignedTransactionMatchesInput {
  owner: string;
  unsignedTxBase64: string;
  signedTxBase64: string;
}

/**
 * Binds signer output to the exact transaction that passed the wire policy.
 *
 * A modifying signer is allowed by the generic Solana signer interface, but
 * Rings approves one immutable compiled message. The signed envelope must
 * therefore contain that message unchanged and exactly one non-null signature
 * in its sole owner slot.
 */
export async function assertRingsSignedTransactionMatches(
  input: AssertRingsSignedTransactionMatchesInput
): Promise<string> {
  try {
    const owner = address(input.owner);
    const unsigned = decodeCanonicalTransaction(input.unsignedTxBase64);
    const signed = decodeCanonicalTransaction(input.signedTxBase64);

    if (!equalBytes(unsigned.messageBytes, signed.messageBytes)) {
      throw new Error("signed message changed");
    }

    const unsignedSignatures = Object.entries(unsigned.signatures);
    const signedSignatures = Object.entries(signed.signatures);
    if (
      unsignedSignatures.length !== 1 ||
      unsignedSignatures[0]?.[0] !== owner ||
      unsignedSignatures[0]?.[1] !== null ||
      signedSignatures.length !== 1 ||
      signedSignatures[0]?.[0] !== owner ||
      signedSignatures[0]?.[1] === null
    ) {
      throw new Error("signed envelope has unexpected signatures");
    }

    const ownerSignature = signedSignatures[0][1];
    const ownerPublicKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(getAddressEncoder().encode(owner)),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    if (
      !(await verifySignature(ownerPublicKey, signatureBytes(ownerSignature), signed.messageBytes))
    ) {
      throw new Error("owner signature does not verify");
    }

    return getSignatureFromTransaction(signed);
  } catch {
    throw new RingsAdapterError(
      "signer_failed",
      "signer output does not match the approved transaction",
      { retryable: false }
    );
  }
}

function decodeCanonicalTransaction(value: string): Transaction {
  const bytes = new Uint8Array(getBase64Codec().encode(value));
  const [transaction, offset] = getTransactionDecoder().read(bytes, 0);
  if (offset !== bytes.length || !equalBytes(getTransactionEncoder().encode(transaction), bytes)) {
    throw new Error("noncanonical transaction");
  }
  return transaction;
}

function equalBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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

  // Unreachable via the public-key lookup, but the cost of being wrong is
  // signing someone else's transfer. Names the row so an operator can find the
  // divergence between it and its provider.
  if (signer.address !== input.owner) {
    throw new SigningError(
      `custody wallet ${wallet.id} resolved ${signer.address} for owner ${input.owner}`,
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
