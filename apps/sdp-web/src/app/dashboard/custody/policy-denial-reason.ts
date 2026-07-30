/**
 * A policy denial answers "which control stopped this?" in `error.details`, while
 * `error.message` stays generic — "Wallet operation denied by policy". Surfacing only
 * the generic half tells an admin a rule fired but never which one, which is the
 * difference between a dead end and a fix.
 *
 * `reason` is prose written for a human; `reasonCode` is the machine token and is only
 * used when there is no prose, tidied from `destination_not_allowlisted` into
 * "Destination not allowlisted".
 *
 * @param body - Raw response body from a failed SDP API call.
 * @returns The specific reason, or `null` when the body carries none.
 */
export function extractPolicyDenialReason(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const details = (
    parsed as { error?: { details?: { reason?: unknown; reasonCode?: unknown } } } | null
  )?.error?.details;
  if (!details) {
    return null;
  }

  const reason = typeof details.reason === "string" ? details.reason.trim() : "";
  if (reason) {
    return reason;
  }

  const reasonCode = typeof details.reasonCode === "string" ? details.reasonCode.trim() : "";
  if (!reasonCode) {
    return null;
  }

  const words = reasonCode.replaceAll("_", " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

/**
 * Joins the generic API message with the specific policy reason, skipping the join
 * when the message already says it.
 */
export function withPolicyDenialReason(message: string, reason: string | null): string {
  if (!reason) {
    return message;
  }
  if (message.toLowerCase().includes(reason.toLowerCase())) {
    return message;
  }
  return `${message} — ${reason}`;
}
