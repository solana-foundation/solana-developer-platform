import { createHash } from "node:crypto";
import {
  generateKeyPair,
  getAddressFromPublicKey,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  type SignatureBytes,
} from "@solana/kit";

/** The one sponsor identity every fee-payment mock signs with. */
export const TEST_MOCK_FEE_PAYER_KEY_PAIR = await generateKeyPair();
export const TEST_MOCK_FEE_PAYER = await getAddressFromPublicKey(
  TEST_MOCK_FEE_PAYER_KEY_PAIR.publicKey
);

/** Attach a real sponsor signature when the message names the mock fee payer. */
export async function sponsorSignTestTransaction(
  transactionBytes: Uint8Array
): Promise<Uint8Array> {
  const transaction = getTransactionDecoder().decode(transactionBytes);
  const signed =
    TEST_MOCK_FEE_PAYER in transaction.signatures
      ? await partiallySignTransaction([TEST_MOCK_FEE_PAYER_KEY_PAIR], transaction)
      : transaction;
  return new Uint8Array(getTransactionEncoder().encode(signed));
}

/**
 * Sponsor slot gets a real signature; every other missing slot is filled with
 * deterministic fake bytes so the result decodes as fully signed.
 */
export async function fullySignTestTransaction(transactionBytes: Uint8Array): Promise<Uint8Array> {
  const transaction = getTransactionDecoder().decode(
    await sponsorSignTestTransaction(transactionBytes)
  );
  const signatureSeed = createHash("sha512")
    .update(new Uint8Array(transaction.messageBytes))
    .digest();
  const signatures = Object.fromEntries(
    Object.entries(transaction.signatures).map(([signer, signature], index) => [
      signer,
      signature ?? (new Uint8Array(signatureSeed.map((byte) => byte ^ index)) as SignatureBytes),
    ])
  ) as typeof transaction.signatures;
  return new Uint8Array(getTransactionEncoder().encode({ ...transaction, signatures }));
}
