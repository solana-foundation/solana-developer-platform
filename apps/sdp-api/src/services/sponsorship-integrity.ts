import {
  type Address,
  bytesEqual,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  type Transaction,
  verifySignature,
} from "@solana/kit";

/**
 * The sponsor returned a valid fee-payer signature over a DIFFERENT message
 * than SDP compiled. Those bytes are sendable, so the spend outcome is
 * ambiguous: callers must retain the reservation as charged-unknown.
 */
export class SponsorMessageMismatchError extends Error {
  constructor() {
    super("Sponsored transaction came back over a different message");
    this.name = "SponsorMessageMismatchError";
  }
}

/**
 * The sponsor's response provably never became sendable: its fee-payer
 * signature slot is empty or holds bytes that do not verify over the returned
 * message. Nothing was spent, so callers may release the reservation
 * deterministically.
 */
export class SponsorResponseUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SponsorResponseUnusableError";
  }
}

const sponsorKeys = new Map<Address, ReturnType<typeof getPublicKeyFromAddress>>();

function getSponsorKey(sponsor: Address): ReturnType<typeof getPublicKeyFromAddress> {
  let key = sponsorKeys.get(sponsor);
  if (!key) {
    key = getPublicKeyFromAddress(sponsor);
    sponsorKeys.set(sponsor, key);
  }
  return key;
}

/**
 * Refuses paymaster bytes that are not the sponsor's valid signature over
 * exactly the message SDP compiled, classifying every failure by whether the
 * sponsor's funds could still move.
 *
 * A paymaster returns bytes rather than a signature, so it could substitute a
 * different message while still providing a valid fee-payer signature, or
 * fill the slot with garbage that a durable record would misrepresent as a
 * signed in-flight transaction. The expected sponsor is read from the
 * requested message's own fee payer, so verification is pinned to the address
 * the transaction was built with rather than a separate provider lookup that
 * could rotate or fail independently.
 *
 * Runs on every sponsorship port seam before the response is persisted or
 * handed out. Throws `SponsorMessageMismatchError` when a valid sponsor
 * signature rides a substituted message (ambiguous — those bytes are
 * sendable) and `SponsorResponseUnusableError` when the signature is missing
 * or invalid (deterministic — nothing sendable was produced).
 *
 * @param params - The requested transaction bytes and the sponsor's response.
 * @param params.requested - The transaction SDP handed to the sponsor.
 * @param params.sponsorSigned - The bytes returned by the sponsor.
 * @returns The decoded sponsor-signed transaction.
 */
export async function assertSponsorSignedSameMessage(params: {
  requested: Uint8Array;
  sponsorSigned: Uint8Array;
}): Promise<Transaction> {
  const requested = getTransactionDecoder().decode(params.requested);
  const sponsor = getCompiledTransactionMessageDecoder().decode(requested.messageBytes)
    .staticAccounts[0];
  if (sponsor === undefined) {
    throw new SponsorResponseUnusableError("Requested transaction carries no fee payer");
  }
  const sponsorSigned = getTransactionDecoder().decode(params.sponsorSigned);
  const sponsorSignature = sponsorSigned.signatures[sponsor];
  const signatureValid =
    sponsorSignature !== null &&
    sponsorSignature !== undefined &&
    (await verifySignature(
      await getSponsorKey(sponsor),
      sponsorSignature,
      sponsorSigned.messageBytes
    ));
  if (signatureValid && bytesEqual(sponsorSigned.messageBytes, requested.messageBytes)) {
    return sponsorSigned;
  }
  if (signatureValid) {
    throw new SponsorMessageMismatchError();
  }
  throw new SponsorResponseUnusableError(
    sponsorSignature === null || sponsorSignature === undefined
      ? "Sponsored transaction is missing the sponsor fee-payer signature"
      : "Sponsored transaction carries an invalid sponsor fee-payer signature"
  );
}
