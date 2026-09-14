import {
  type Address,
  bytesEqual,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  type Transaction,
  verifySignature,
} from "@solana/kit";

// A valid sponsor signature over a substituted message is sendable: ambiguous spend.
export class SponsorMessageMismatchError extends Error {
  constructor() {
    super("Sponsored transaction came back over a different message");
    this.name = "SponsorMessageMismatchError";
  }
}

// An empty sponsor slot provably spent nothing: safe to release.
export class SponsorResponseUnusableError extends Error {
  constructor() {
    super("Sponsored transaction is missing the sponsor fee-payer signature");
    this.name = "SponsorResponseUnusableError";
  }
}

export function requestedSponsor(requested: Transaction): Address {
  const sponsor = Object.keys(requested.signatures)[0] as Address | undefined;
  if (sponsor === undefined) {
    throw new SponsorResponseUnusableError();
  }
  return sponsor;
}

export async function assertSponsorSignedSameMessage(params: {
  requested: Uint8Array;
  sponsorSigned: Uint8Array;
}): Promise<Transaction> {
  const requested = getTransactionDecoder().decode(params.requested);
  const sponsor = requestedSponsor(requested);
  const sponsorSigned = getTransactionDecoder().decode(params.sponsorSigned);
  const sponsorSignature = sponsorSigned.signatures[sponsor];
  if (sponsorSignature === null || sponsorSignature === undefined) {
    throw new SponsorResponseUnusableError();
  }
  const signatureValid = await verifySignature(
    await getPublicKeyFromAddress(sponsor),
    sponsorSignature,
    sponsorSigned.messageBytes
  );
  if (!signatureValid) {
    throw new Error("Sponsored transaction carries an invalid sponsor fee-payer signature");
  }
  if (!bytesEqual(sponsorSigned.messageBytes, requested.messageBytes)) {
    throw new SponsorMessageMismatchError();
  }
  return sponsorSigned;
}
