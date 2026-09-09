import {
  type Address,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getBase64Codec,
  getSignatureFromTransaction,
  getTransactionEncoder,
  pipe,
  type SignatureBytes,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

const FEE_PAYER = "11111111111111111111111111111111" as Address;
const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash;

/**
 * Unsigned outer transaction wire bytes for a given fee payer.
 *
 * Used where a test needs to sign locally and derive the signature the service
 * will persist before broadcast.
 */
export function unsignedRingsTransaction(feePayer: Address): string {
  const compiled = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(feePayer, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
          message
        )
    )
  );
  return getBase64Codec().decode(getTransactionEncoder().encode(compiled));
}

/**
 * A signed outer transaction as base64 wire bytes, plus the signature the
 * service derives from them.
 *
 * `HeliusRingsService` persists the outer signature before broadcasting, which
 * means it decodes what the signer returned — so a sign/submit test double has
 * to hand back a real transaction, not a placeholder string. `fill` byte-fills
 * the signature so two fixtures in one test are distinguishable.
 */
export function signedRingsTransaction(fill: number): {
  signedTxBase64: string;
  signature: string;
} {
  const compiled = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(FEE_PAYER, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
          message
        )
    )
  );
  const signed = {
    ...compiled,
    signatures: { [FEE_PAYER]: new Uint8Array(64).fill(fill) as SignatureBytes },
  };

  return {
    signedTxBase64: getBase64Codec().decode(getTransactionEncoder().encode(signed)),
    signature: getSignatureFromTransaction(signed),
  };
}
