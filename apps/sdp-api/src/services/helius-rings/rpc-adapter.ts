import { createRpc, type SolanaRpc, sendTransaction } from "@sdp/rpc/solana";
import { getBase64Codec } from "@solana/codecs";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";

/**
 * Broadcasts the signed outer transaction over the existing SDP RPC path.
 * Failures are raised retryable for provisioning, which re-reads the user record
 * before rebuilding; the operation pipeline ignores the bit and asks Photon.
 */

export interface SubmitRingsOuterTransactionInput {
  env: Env;
  signedTxBase64: string;
  /** Test seam; production resolves the env RPC. */
  rpc?: SolanaRpc;
}

export async function submitRingsOuterTransaction(
  input: SubmitRingsOuterTransactionInput
): Promise<string> {
  const rpc = input.rpc ?? createRpc(input.env);
  const signedBytes = getBase64Codec().encode(input.signedTxBase64);

  try {
    return await sendTransaction(rpc, new Uint8Array(signedBytes));
  } catch (error) {
    const message = error instanceof Error ? error.message : "transaction submission failed";
    throw new RingsAdapterError("submit_failed", message, { retryable: true, cause: error });
  }
}
