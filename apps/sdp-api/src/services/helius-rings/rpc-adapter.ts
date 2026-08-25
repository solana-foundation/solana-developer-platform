import { createRpc, type SolanaRpc, sendTransaction } from "@sdp/rpc/solana";
import { getBase64Codec } from "@solana/codecs";
import {
  type Blockhash,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Signature,
} from "@solana/kit";
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
 * What the chain says about one signed transaction.
 *
 * Two independent questions, because either answer alone is not enough to
 * declare a transaction dead: whether a finalized node has it, and whether the
 * blockhash it carries could still be accepted.
 */
export interface RingsSignatureInspection {
  /** Slot a finalized node reports, or null when it has no record. */
  readonly landedSlot: string | null;
  /**
   * Whether the transaction could still be included.
   *
   * Read from the blockhash inside the signed bytes, never from the
   * `last_valid_block_height` column: that column is a floor for a shield and a
   * merge, because those take their blockhash from the SDK's own builder. Using
   * the column to declare absence is exactly the premature-expiry mistake this
   * check exists to avoid.
   */
  readonly blockhashValid: boolean;
}

export interface InspectRingsSignatureInput {
  env: Env;
  signature: string;
  signedTxBase64: string;
  rpc?: SolanaRpc;
}

export async function inspectRingsSignature(
  input: InspectRingsSignatureInput
): Promise<RingsSignatureInspection> {
  const rpc = input.rpc ?? createRpc(input.env);

  const transaction = getTransactionDecoder().decode(getBase64Codec().encode(input.signedTxBase64));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const lifetime = message.lifetimeToken;

  // Finalized, because a lesser commitment can still be dropped, and the whole
  // point of the question is whether this is irreversible.
  const [landed, blockhash] = await Promise.all([
    // `base64` because only the slot is read; asking for a parsed transaction
    // would make the node do work nobody looks at.
    rpc
      .getTransaction(input.signature as Signature, {
        commitment: "finalized",
        encoding: "base64",
        maxSupportedTransactionVersion: 0,
      })
      .send(),
    rpc.isBlockhashValid(lifetime as Blockhash, { commitment: "finalized" }).send(),
  ]);

  return {
    landedSlot: landed === null ? null : String(landed.slot),
    blockhashValid: blockhash.value,
  };
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
