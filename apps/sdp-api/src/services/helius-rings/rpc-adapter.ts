import { decodeShieldedPoolError } from "@sdp/helius-rings-sdk";
import {
  createClusterRpc,
  createEndpointRpc,
  createEndpointRpcFromTransport,
} from "@sdp/rpc/factory";
import {
  DEFAULT_RPC_REQUEST_TIMEOUT_MS,
  getSignatureStatuses,
  type SolanaRpc,
  sendTransaction,
} from "@sdp/rpc/solana";
import { getBase64Codec } from "@solana/codecs";
import {
  isSolanaError,
  type Signature,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
} from "@solana/kit";
import { createCustomerRpcTransport } from "@/services/rpc-egress";
import type { Env } from "@/types/env";
import { RingsAdapterError, type RingsAdapterFailureCode } from "./adapter-error";

/**
 * Broadcasts the signed outer transaction through the operation's persisted
 * connection RPC, or the open cluster scope's managed RPC pool when none is given.
 *
 * Failures are retryable because the RPC cannot tell a dropped transaction from
 * a transient outage. Retrying is only safe because of the submission outbox: a
 * resubmission sends the exact persisted bytes, where a rebuild could select
 * different notes and land a second transaction beside the first.
 */

export interface SubmitRingsOuterTransactionInput {
  env: Env;
  signedTxBase64: string;
  /** Persisted Rings connection URL; omitted, the scope's managed pool broadcasts. */
  rpcUrl?: string;
  /** Test seam; production resolves the connection or the managed pool. */
  rpc?: SolanaRpc;
}

/**
 * Broadcast signed Rings bytes and classify a failure into a `RingsAdapterError`.
 *
 * @param input - The bytes and where to broadcast them.
 * @param input.env - Process env; decides whether a persisted URL is dialed through the guarded transport.
 * @param input.signedTxBase64 - The signed outer transaction, base64-encoded.
 * @param input.rpcUrl - The operation's persisted connection URL, dialed explicitly; omitted, the open cluster scope's managed pool broadcasts.
 * @param input.rpc - Test seam that replaces both.
 * @returns The transaction signature the RPC reports.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` when no `rpcUrl` or `rpc` is given outside a cluster scope.
 * @throws RingsAdapterError when the broadcast fails, with the persisted URL redacted from its message.
 */
export async function submitRingsOuterTransaction(
  input: SubmitRingsOuterTransactionInput
): Promise<string> {
  let persistedRpcUrl: string | undefined;
  let rpc: SolanaRpc;
  if (input.rpc) {
    rpc = input.rpc;
  } else if (input.rpcUrl) {
    persistedRpcUrl = input.rpcUrl;
    // A persisted connection URL is tenant-controlled, so outside development
    // it is dialed through the guarded transport: DNS-checked at connect time,
    // redirects re-guarded per hop. Development keeps the plain client — local
    // endpoints legitimately resolve to loopback.
    rpc =
      input.env.ENVIRONMENT === "development"
        ? createEndpointRpc(input.rpcUrl, { timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS })
        : createEndpointRpcFromTransport(createCustomerRpcTransport(input.rpcUrl), {
            timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS,
          });
  } else {
    rpc = createClusterRpc();
  }
  const signedBytes = getBase64Codec().encode(input.signedTxBase64);

  try {
    return await sendTransaction(rpc, new Uint8Array(signedBytes));
  } catch (error) {
    const classified = classifySubmitError(error);
    throw new RingsAdapterError(classified.failureCode, classified.message, {
      retryable: classified.retryable,
      cause: error,
      // A persisted URL may carry its credential; sanitize the exact endpoint
      // while retaining its origin for diagnostics.
      sensitiveUrls: persistedRpcUrl ? [persistedRpcUrl] : [],
    });
  }
}

const PREFLIGHT_LOG_TAIL = 3;

// `Program log: …` (program self-logs) and `Program X failed: …` (program-level
// panic reasons) are the two log shapes that carry diagnosis. Frame markers —
// invoke/success/consumed — never do, so filtering them out keeps the row
// message focused on the actual reason. Both alternatives are anchored so
// `failed:` appearing inside a log body doesn't slip through on its own.
const DIAGNOSTIC_LOG_LINE = /^Program (?:(?:log|data|return): |\S+ failed:)/;

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

  if (
    isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
  ) {
    const causeMessage = error.cause instanceof Error ? error.cause.message : null;
    const poolErrorName = decodeShieldedPoolCustomError(error);
    const namedCause =
      poolErrorName && causeMessage
        ? `${poolErrorName} (${causeMessage})`
        : (poolErrorName ?? causeMessage);
    const tail = readDiagnosticLogs(error).slice(-PREFLIGHT_LOG_TAIL).join(" | ");
    const head = namedCause ? `${fallback}: ${namedCause}` : fallback;
    return {
      failureCode: "manual_reconciliation_required",
      message: tail ? `${head} — ${tail}` : head,
      retryable: false,
    };
  }

  return { failureCode: "submit_failed", message: fallback, retryable: true };
}

// Walks the cause chain for an InstructionError.Custom SolanaError and, if the
// numeric code matches a Rings pool error, returns its symbolic name.
function decodeShieldedPoolCustomError(error: unknown): string | null {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (isSolanaError(current, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
      const code = current.context.code;
      if (typeof code === "number") {
        const decoded = decodeShieldedPoolError(code);
        if (decoded.kind === "known") return decoded.name;
      }
      return null;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
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
 *
 * @param input - Where to read the height.
 * @param input.rpc - Test seam; production reads the open cluster scope's managed RPC pool.
 * @returns The block height, or `null` when the RPC call failed.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope, or `RPC_NOT_CONFIGURED` when the scope's cluster has no endpoint.
 */
export async function readRingsBlockHeight(input: { rpc?: SolanaRpc }): Promise<string | null> {
  const rpc = input.rpc ?? createClusterRpc();
  try {
    return (await rpc.getBlockHeight().send()).toString();
  } catch {
    // Not knowing the height means this tick cannot judge expiry — a reason to
    // leave operations alone, not to abandon the rest of the sweep.
    return null;
  }
}

/** What the chain knows about a signature, where `null` is "could not ask". */
export type RingsSignatureOutcome = "landed" | "failed" | "absent";

/**
 * Asks the chain whether signed bytes ever executed.
 *
 * The history is searched because the recent-status cache holds only a few
 * hundred slots, far less than the indexing budget an operation is judged
 * against. Absence is reported only when the RPC answered and had nothing; a
 * call that fails returns `null`, since an unreachable RPC is not evidence a
 * transaction never landed.
 *
 * @param input - The signature and where to ask.
 * @param input.signature - The outer transaction's signature.
 * @param input.rpc - Test seam; production reads the open cluster scope's managed RPC pool.
 * @returns What the chain knows about the signature, or `null` when the RPC call failed.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope, or `RPC_NOT_CONFIGURED` when the scope's cluster has no endpoint.
 */
export async function readRingsSignatureStatus(input: {
  signature: string;
  rpc?: SolanaRpc;
}): Promise<RingsSignatureOutcome | null> {
  const rpc = input.rpc ?? createClusterRpc();
  try {
    const [status] = await getSignatureStatuses(rpc, [input.signature as Signature], {
      searchTransactionHistory: true,
    });

    if (!status) return "absent";
    return status.err === null ? "landed" : "failed";
  } catch {
    return null;
  }
}
