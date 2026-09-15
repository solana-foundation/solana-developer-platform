import { FeePaymentError } from "@sdp/payments/fee-payment";
import {
  type Address,
  bytesEqual,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  type Transaction,
  verifySignature,
} from "@solana/kit";

// A substituted message may carry a sendable sponsor signature: ambiguous spend.
export class SponsorMessageMismatchError extends FeePaymentError {
  constructor() {
    super("Sponsored transaction came back over a different message", "PROVIDER_NOT_AVAILABLE");
    this.name = "SponsorMessageMismatchError";
  }
}

// An empty sponsor slot over the identical message provably spent nothing: safe to release.
export class SponsorResponseUnusableError extends FeePaymentError {
  constructor() {
    super(
      "Sponsored transaction is missing the sponsor fee-payer signature",
      "PROVIDER_NOT_AVAILABLE"
    );
    this.name = "SponsorResponseUnusableError";
  }
}

export class SponsorResponseUndecodableError extends Error {
  constructor(cause: unknown) {
    super("Sponsored transaction bytes could not be decoded", { cause });
    this.name = "SponsorResponseUndecodableError";
  }
}

const sponsorKeys = new Map<Address, ReturnType<typeof getPublicKeyFromAddress>>();

function getSponsorKey(sponsor: Address): ReturnType<typeof getPublicKeyFromAddress> {
  let key = sponsorKeys.get(sponsor);
  if (!key) {
    key = getPublicKeyFromAddress(sponsor);
    key.catch(() => sponsorKeys.delete(sponsor));
    sponsorKeys.set(sponsor, key);
  }
  return key;
}

export async function assertSponsorSignedSameMessage(params: {
  requested: Uint8Array | Transaction;
  sponsorSigned: Uint8Array;
  sponsor: Address;
}): Promise<Transaction> {
  const requested =
    params.requested instanceof Uint8Array
      ? getTransactionDecoder().decode(params.requested)
      : params.requested;
  let sponsorSigned: Transaction;
  try {
    sponsorSigned = getTransactionDecoder().decode(params.sponsorSigned);
  } catch (error) {
    throw new SponsorResponseUndecodableError(error);
  }
  if (!bytesEqual(sponsorSigned.messageBytes, requested.messageBytes)) {
    throw new SponsorMessageMismatchError();
  }
  const sponsorSignature = sponsorSigned.signatures[params.sponsor];
  if (sponsorSignature === null || sponsorSignature === undefined) {
    throw new SponsorResponseUnusableError();
  }
  const signatureValid = await verifySignature(
    await getSponsorKey(params.sponsor),
    sponsorSignature,
    sponsorSigned.messageBytes
  );
  if (!signatureValid) {
    throw new FeePaymentError(
      "Sponsored transaction carries an invalid sponsor fee-payer signature",
      "PROVIDER_NOT_AVAILABLE"
    );
  }
  return sponsorSigned;
}
