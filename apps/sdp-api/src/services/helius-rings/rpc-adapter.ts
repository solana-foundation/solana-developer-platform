import { createRpc, type SolanaRpc, sendTransaction } from "@sdp/rpc/solana";
import { getBase64Codec } from "@solana/codecs";
import {
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
} from "@solana/kit";
import type { Env } from "@/types/env";
import { RingsAdapterError, type RingsAdapterFailureCode } from "./adapter-error";
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
    const classified = classifySubmitError(error);
    throw new RingsAdapterError(classified.failureCode, classified.message, {
      retryable: classified.retryable,
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

const PREFLIGHT_LOG_TAIL = 3;

// `Program log: …` (program self-logs) and `Program X failed: …` (program-level
// panic reasons) are the two log shapes that carry diagnosis. Frame markers —
// invoke/success/consumed — never do, so filtering them out keeps the row
// message focused on the actual reason.
const DIAGNOSTIC_LOG_LINE = /^Program (?:log|data|return): |failed:/;

interface ClassifiedSubmitError {
  failureCode: RingsAdapterFailureCode;
  message: string;
  retryable: boolean;
}

// Preflight failures: bytes were rejected before broadcast, so nothing landed
// and nothing will — escalate straight to manual_reconciliation_required so
// the void action unblocks the wallet without waiting for the sweep. Other
// submit failures stay ambiguous (bytes may have gone out) and retry-eligible.
function classifySubmitError(error: unknown): ClassifiedSubmitError {
  const fallback = error instanceof Error ? error.message : "transaction submission failed";

  if (isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
    const causeMessage = error.cause instanceof Error ? error.cause.message : null;
    const tail = readDiagnosticLogs(error).slice(-PREFLIGHT_LOG_TAIL).join(" | ");
    const head = causeMessage ? `${fallback}: ${causeMessage}` : fallback;
    return {
      failureCode: "manual_reconciliation_required",
      message: tail ? `${head} — ${tail}` : head,
      retryable: false,
    };
  }

  return { failureCode: "submit_failed", message: fallback, retryable: true };
}

function readDiagnosticLogs(error: unknown): readonly string[] {
  const logs = (error as { context?: { logs?: unknown } })?.context?.logs;
  if (!Array.isArray(logs)) return [];
  return logs.filter(
    (entry): entry is string => typeof entry === "string" && DIAGNOSTIC_LOG_LINE.test(entry)
  );
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
