/**
 * Solana Funding Helpers
 *
 * Utilities for funding accounts in non-production environments.
 */

import type { Env } from "@/types/env";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  type Address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { confirmTransaction, createRpc, getRecentBlockhash } from "./rpc";
import { createSigner } from "./signer";

/**
 * Transfer lamports from the env signer to a destination address.
 *
 * Intended for dev/test environments (e.g., integration tests).
 */
export async function transferLamportsFromEnv(
  env: Env,
  destination: string,
  lamports: bigint,
  commitment: "confirmed" | "finalized" = "confirmed"
): Promise<string> {
  const signer = await createSigner(env);
  const rpc = createRpc(env);

  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, commitment);

  const instruction = getTransferSolInstruction({
    source: signer,
    destination: destination as Address,
    amount: lamports,
  });

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions([instruction], m),
    (m) => addSignersToTransactionMessage([signer], m)
  );

  const signedMessage = await signTransactionMessageWithSigners(message);
  const encoded = getBase64EncodedWireTransaction(signedMessage);
  const signature = await rpc
    .sendTransaction(encoded, {
      encoding: "base64",
    })
    .send();

  await confirmTransaction(rpc, signature, { commitment });

  return signature as string;
}
