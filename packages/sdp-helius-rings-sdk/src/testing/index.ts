import {
  address,
  appendTransactionMessageInstruction,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64Codec,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

/**
 * Test-only surface, exported through `@sdp/helius-rings-sdk/testing`.
 *
 * It exists for one assertion that cannot be made from inside this package:
 * this package resolves `@solana/kit` 7 and `@sdp/api` resolves 6, so only a
 * test living in the consumer can prove that bytes produced under one major
 * are readable under the other. Nothing here ships.
 */

// biome-ignore lint/security/noSecrets: the SPL Memo program id, not a secret.
const MEMO_PROGRAM = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/**
 * Compiles an unsigned transaction with **Kit 7** and returns it base64-encoded,
 * in the same wire form `buildOperation` will hand across the port.
 */
export function encodeUnsignedTransactionBase64(
  input: Readonly<{ feePayer: string; blockhash: string; lastValidBlockHeight: bigint }>
): string {
  const message = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: input.blockhash as Blockhash,
      lastValidBlockHeight: input.lastValidBlockHeight,
    },
    setTransactionMessageFeePayer(
      address(input.feePayer),
      appendTransactionMessageInstruction(
        { programAddress: MEMO_PROGRAM, data: new Uint8Array([1, 2, 3]) },
        createTransactionMessage({ version: 0 })
      )
    )
  );

  const transaction = compileTransaction(message);
  return getBase64Codec().decode(getTransactionEncoder().encode(transaction));
}
