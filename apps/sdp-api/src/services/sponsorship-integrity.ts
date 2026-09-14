import {
  type Address,
  bytesEqual,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  type Transaction,
  verifySignature,
} from "@solana/kit";

/**
 * Refuses paymaster bytes that are not the sponsor's signature over exactly
 * the message SDP compiled.
 *
 * A paymaster returns bytes rather than a signature, so it could substitute a
 * different message while still providing a valid fee-payer signature. This
 * check also forbids relayers from injecting instructions after SDP simulated
 * or size-checked the transaction. The sponsor's signature is then verified
 * against its public key: a filled slot alone would let a corrupted response
 * be persisted as an in-flight transaction that only the RPC could reject.
 *
 * @param params - The compiled transaction, returned bytes, and expected sponsor.
 * @param params.unsignedOrPartiallySigned - The transaction SDP handed to the sponsor.
 * @param params.sponsorSigned - The bytes returned by the sponsor.
 * @param params.sponsor - The address whose signature must be present and valid.
 * @returns The decoded sponsor-signed transaction.
 */
export async function assertSponsorSignedSameMessage(params: {
  unsignedOrPartiallySigned: Transaction;
  sponsorSigned: Uint8Array;
  sponsor: Address;
}): Promise<Transaction> {
  const sponsorSigned = getTransactionDecoder().decode(params.sponsorSigned);
  if (!bytesEqual(sponsorSigned.messageBytes, params.unsignedOrPartiallySigned.messageBytes)) {
    throw new Error("Sponsored transaction came back over a different message");
  }
  const sponsorSignature = sponsorSigned.signatures[params.sponsor];
  if (sponsorSignature === null || sponsorSignature === undefined) {
    throw new Error("Sponsored transaction is missing the sponsor fee-payer signature");
  }
  const sponsorKey = await getPublicKeyFromAddress(params.sponsor);
  if (!(await verifySignature(sponsorKey, sponsorSignature, sponsorSigned.messageBytes))) {
    throw new Error("Sponsored transaction carries an invalid sponsor fee-payer signature");
  }
  return sponsorSigned;
}

/**
 * Byte-level entry point for seams that hold the requested transaction only as
 * encoded bytes.
 *
 * @param params - The requested bytes, the sponsor's response, and the sponsor.
 * @returns The decoded sponsor-signed transaction.
 */
export async function assertSponsorSignedSameMessageBytes(params: {
  requested: Uint8Array;
  sponsorSigned: Uint8Array;
  sponsor: Address;
}): Promise<Transaction> {
  return assertSponsorSignedSameMessage({
    unsignedOrPartiallySigned: getTransactionDecoder().decode(params.requested),
    sponsorSigned: params.sponsorSigned,
    sponsor: params.sponsor,
  });
}

/**
 * The structural half of the sponsor-response check, enforced on every
 * sponsorship seam: the returned bytes must carry exactly the requested
 * message with the sponsor's signature slot filled.
 *
 * Message substitution and instruction injection are caught here even on a
 * path that never adds the cryptographic verification. Signature validity is
 * deliberately left to the path-level `assertSponsorSignedSameMessage` call:
 * an invalid signature over the correct message can only fail at the RPC,
 * while a substituted message would spend the sponsor's funds on something
 * SDP never built.
 *
 * @param params - The requested bytes, the sponsor's response, and the sponsor.
 * @returns The decoded sponsor-signed transaction.
 */
export function assertSponsorReturnedSameMessage(params: {
  requested: Uint8Array;
  sponsorSigned: Uint8Array;
  sponsor: Address;
}): Transaction {
  const requested = getTransactionDecoder().decode(params.requested);
  const sponsorSigned = getTransactionDecoder().decode(params.sponsorSigned);
  if (!bytesEqual(sponsorSigned.messageBytes, requested.messageBytes)) {
    throw new Error("Sponsored transaction came back over a different message");
  }
  const sponsorSignature = sponsorSigned.signatures[params.sponsor];
  if (sponsorSignature === null || sponsorSignature === undefined) {
    throw new Error("Sponsored transaction is missing the sponsor fee-payer signature");
  }
  return sponsorSigned;
}
