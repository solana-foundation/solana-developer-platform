import { createRpc, type SolanaRpc, sendTransaction } from "@sdp/rpc/solana";
import { getBase64Codec } from "@solana/codecs";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";

/**
 * Broadcasts the signed outer transaction over the existing SDP RPC path.
 *
 * Submission failures are reported as retryable because the RPC cannot tell a
 * dropped transaction from a transient outage. What makes acting on that safe is
 * the submission outbox, not the intent key: a resubmission must send the exact
 * persisted bytes. Rebuilding the operation instead would let a re-synced wallet
 * select different notes and land a second transaction beside the first.
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

/**
 * Current chain height, for deciding whether signed bytes can still land.
 *
 * Returned as a string because the height is a uint64 and the callers compare
 * it against `last_valid_block_height`, a NUMERIC column read as a string.
 * Routing it through `number` would start losing precision inside the range the
 * column allows.
 */
export async function readRingsBlockHeight(input: {
  env: Env;
  rpc?: SolanaRpc;
}): Promise<string | null> {
  const rpc = input.rpc ?? createRpc(input.env);

  try {
    return (await rpc.getBlockHeight().send()).toString();
  } catch {
    // Null rather than throwing: not knowing the height means the sweep cannot
    // judge expiry this tick, which is a reason to leave operations alone
    // rather than to abandon the rest of the sweep.
    return null;
  }
}
