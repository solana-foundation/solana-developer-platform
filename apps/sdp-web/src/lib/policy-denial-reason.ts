/**
 * A policy denial answers "which control stopped this?" in `error.details`, while
 * `error.message` stays generic — "Wallet operation denied by policy". Surfacing only
 * the generic half tells an admin a rule fired but never which one, which is the
 * difference between a dead end and a fix.
 *
 * Only `reason` is read. It is the prose that names the rule, and
 * `policy-evaluation.service.ts` populates it on every branch that can produce a
 * denial, so there is no case where the code is present and it is not. `reasonCode`
 * is deliberately ignored: it names the *scope* that decided (`wallet_policy_match`,
 * `api_key_policy_match`), never the rule, so surfacing it produced "Wallet operation
 * denied by policy — Wallet policy match" — a restatement of the message rather than
 * the specific answer this exists to give.
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

  const details = (parsed as { error?: { details?: { reason?: unknown } } } | null)?.error?.details;
  if (!details) {
    return null;
  }

  const reason = typeof details.reason === "string" ? details.reason.trim() : "";
  return reason || null;
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
