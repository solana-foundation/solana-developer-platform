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
import { requireRingsHeliusRpcUrl } from "./rpc-config";

function createRingsHeliusRpc(env: Env): { rpc: SolanaRpc; rpcUrl: string } {
  const rpcUrl = requireRingsHeliusRpcUrl(env);
  return { rpc: createRpc(env, { rpcUrl }), rpcUrl };
}

/**
 * Broadcasts the signed outer transaction through the configured Helius RPC.
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
  let resolvedRpcUrl: string | undefined;
  let rpc: SolanaRpc;
  if (input.rpc) {
    rpc = input.rpc;
  } else {
    const configuredRpc = createRingsHeliusRpc(input.env);
    rpc = configuredRpc.rpc;
    resolvedRpcUrl = configuredRpc.rpcUrl;
  }
  const signedBytes = getBase64Codec().encode(input.signedTxBase64);

  try {
    return await sendTransaction(rpc, new Uint8Array(signedBytes));
  } catch (error) {
    const message = error instanceof Error ? error.message : "transaction submission failed";
    throw new RingsAdapterError("submit_failed", message, {
      retryable: true,
      cause: error,
      // withHeliusApiKey can place the encoded credential in the URL path, so
      // query-only URL redaction is not sufficient.
      sensitiveValues: [input.env.SOLANA_RPC_HELIUS_API_KEY ?? ""],
      // Pre-keyed URLs have no separate credential value to redact. Sanitize
      // the exact endpoint while retaining its origin for diagnostics.
      sensitiveUrls: resolvedRpcUrl && !input.env.SOLANA_RPC_HELIUS_API_KEY ? [resolvedRpcUrl] : [],
    });
  }
}

/**
 * What the chain says about one signed transaction.
 *
 * Absence is the hard question. A transaction's presence can be established by
 * one positive answer, but no single RPC response proves it never existed:
 * `getTransaction` returning null means "not in this node's store", which is
 * also what a node without transaction history, or one backend of a
 * load-balanced pair, says about a transaction that did land. Reconcile
 * therefore requires a history-capable Helius endpoint supporting
 * `getSignatureStatuses` with `searchTransactionHistory` and `getTransaction`;
 * both methods are asked, and both must miss.
 */
export interface RingsSignatureInspection {
  /**
   * Slot the transaction landed in, from whichever history source found it, or
   * null when neither has any record of it.
   */
  readonly landedSlot: string | null;
  /**
   * Whether it landed and then failed on chain.
   *
   * The distinction Photon cannot make: a transaction that reverted changed no
   * shielded state, so the indexer will never report it, however long anyone
   * waits. Treating that as "landed, awaiting the indexer" freezes the wallet
   * for good. It also moved nothing, which is what makes voiding it safe.
   */
  readonly executionFailed: boolean;
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
  /** The raw answers, recorded on the event so a later dispute has them. */
  readonly evidence: Readonly<{
    statusSlot: string | null;
    statusConfirmation: string | null;
    transactionSlot: string | null;
    executionFailed: boolean;
    blockhashValid: boolean;
  }>;
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
  const rpc = input.rpc ?? createRingsHeliusRpc(input.env).rpc;

  const transaction = getTransactionDecoder().decode(getBase64Codec().encode(input.signedTxBase64));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const lifetime = message.lifetimeToken;

  // Serialized rather than concurrent. Two calls to one URL can be answered by
  // different backends, and these two questions read different state: the
  // blockhash comes from the bank, which every node has, while history may be
  // absent on the node that answers. Asking them together invites an answer
  // pair that no single node would have given.
  const blockhash = await rpc
    .isBlockhashValid(lifetime as Blockhash, { commitment: "finalized" })
    .send();

  // The method built for this question: with history search on, it proceeds
  // into local block storage and then archival storage rather than only the
  // recent status cache. It also carries the execution error and the
  // confirmation level, so one call answers all three parts of the question.
  const statuses = await rpc
    .getSignatureStatuses([input.signature as Signature], { searchTransactionHistory: true })
    .send();
  const status = statuses.value[0] ?? null;

  // A second, independent history source, at `confirmed` rather than
  // `finalized`: a transaction that is included but not yet finalized has
  // certainly landed, and asking only about finalized roots would report it
  // absent and invite a duplicate.
  const landed = await rpc
    .getTransaction(input.signature as Signature, {
      commitment: "confirmed",
      encoding: "base64",
      maxSupportedTransactionVersion: 0,
    })
    .send();

  const evidence = {
    statusSlot: status === null ? null : String(status.slot),
    statusConfirmation: status?.confirmationStatus ?? null,
    transactionSlot: landed === null ? null : String(landed.slot),
    executionFailed: status?.err != null || landed?.meta?.err != null,
    blockhashValid: blockhash.value,
  } as const;

  return {
    // Either source finding it is enough to say it landed; only both missing
    // can support the opposite conclusion.
    landedSlot: evidence.statusSlot ?? evidence.transactionSlot,
    executionFailed: evidence.executionFailed,
    blockhashValid: blockhash.value,
    evidence,
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
  try {
    const rpc = input.rpc ?? createRingsHeliusRpc(input.env).rpc;
    return (await rpc.getBlockHeight().send()).toString();
  } catch {
    // Null rather than throwing: not knowing the height means the sweep cannot
    // judge expiry this tick, which is a reason to leave operations alone
    // rather than to abandon the rest of the sweep.
    return null;
  }
}
