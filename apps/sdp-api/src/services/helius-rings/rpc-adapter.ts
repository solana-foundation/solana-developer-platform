import { createRpc, type SolanaRpc, sendTransaction } from "@sdp/rpc/solana";
import { getBase64Codec } from "@solana/codecs";
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
 * Failures are retryable because the RPC cannot tell a dropped transaction from
 * a transient outage. Retrying is only safe because of the submission outbox: a
 * resubmission sends the exact persisted bytes, where a rebuild could select
 * different notes and land a second transaction beside the first.
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
 * Current chain height, for deciding whether signed bytes can still land.
 *
 * A string because the height is a uint64 compared against
 * `last_valid_block_height`, a NUMERIC column read as a string; `number` would
 * lose precision inside the range the column allows.
 */
export async function readRingsBlockHeight(input: {
  env: Env;
  rpc?: SolanaRpc;
}): Promise<string | null> {
  try {
    const rpc = input.rpc ?? createRingsHeliusRpc(input.env).rpc;
    return (await rpc.getBlockHeight().send()).toString();
  } catch {
    // Not knowing the height means this tick cannot judge expiry — a reason to
    // leave operations alone, not to abandon the rest of the sweep.
    return null;
  }
}
