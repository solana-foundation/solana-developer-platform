import type { FailureCode } from "@sdp/helius-rings";
import { REDACTION_CENSOR } from "@/runtime/log-redaction";

/**
 * Strips credentials out of a message before it can be stored or returned.
 *
 * Adapter messages are quoted verbatim from the signer and the RPC, and an RPC
 * that fails to reach a host routinely names the URL it tried — which carries
 * the Helius API key. That message becomes `failure_message` on the operation
 * row and is served back on every read of it, so scrubbing has to happen before
 * the value is stored, not at each place it is displayed.
 *
 * The event feed's redaction cannot cover this: it censors values under known
 * key names, and a key embedded in a sentence has no key name of its own.
 */
export function redactAdapterMessage(message: string): string {
  return (
    message
      // Any URL keeps its scheme, host and path and loses its query, which is
      // where credentials travel. Written as one rule rather than a list of
      // parameter names, so a host that spells its key differently is still
      // covered.
      .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, `$1?${REDACTION_CENSOR}`)
      // The same parameter outside a URL — some clients quote just the query.
      .replace(/\b(api[-_]?key|access[-_]?token|token)=[^\s&]+/gi, `$1=${REDACTION_CENSOR}`)
  );
}

/**
 * Failure from the signer or RPC adapter, carrying exactly what the service
 * needs to take the state machine's fail edge: the operation-level failure
 * code and whether a retry can succeed.
 */
export class RingsAdapterError extends Error {
  readonly failureCode: Extract<FailureCode, "signer_failed" | "submit_failed">;
  readonly retryable: boolean;

  constructor(
    failureCode: Extract<FailureCode, "signer_failed" | "submit_failed">,
    message: string,
    options: { retryable: boolean; cause?: unknown }
  ) {
    // Scrubbed here rather than at the two call sites that build these, so a
    // third one cannot be added without the protection.
    super(redactAdapterMessage(message), { cause: options.cause });
    this.name = "RingsAdapterError";
    this.failureCode = failureCode;
    this.retryable = options.retryable;
  }
}
