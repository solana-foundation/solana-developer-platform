import type { PolicyEvaluationReasonCode } from "@sdp/types";

/**
 * What each reason code is worth saying to an admin, on top of a message that already
 * reads "Wallet operation denied by policy".
 *
 * `null` means the code adds nothing to that sentence, so it is dropped rather than
 * appended: the three allow-only codes cannot accompany a denial at all, and echoing
 * one would claim a control fired when none did. Typing this against the union in
 * `@sdp/types` rather than a hand-kept list means a new code fails the build here
 * instead of silently falling through to the generic branch.
 */
const REASON_CODE_LABELS: Record<PolicyEvaluationReasonCode, string | null> = {
  implicit_default_allow: null,
  wallet_policy_missing: null,
  api_key_policy_missing: null,
  wallet_policy_match: "Matched a wallet policy rule",
  api_key_policy_match: "Matched an API key policy rule",
  manual_review: "Held for manual review",
  provider_mapping_pending: "The custody provider mapping is still pending",
  provider_mapping_partial: "The custody provider mapping is incomplete",
  provider_mapping_failed: "The custody provider mapping failed",
};

/**
 * A policy denial answers "which control stopped this?" in `error.details`, while
 * `error.message` stays generic — "Wallet operation denied by policy". Surfacing only
 * the generic half tells an admin a rule fired but never which one, which is the
 * difference between a dead end and a fix.
 *
 * `reason` is the prose written for a human and is the half that actually names the
 * rule — `policy-evaluation.service.ts` populates it on every branch, so it is the
 * normal case rather than the lucky one. `reasonCode` only names the *layer* that
 * decided, never the rule, so it is a last resort: mechanically de-snake-casing it
 * yielded "Wallet operation denied by policy — Wallet policy match", which restates
 * the message instead of adding to it.
 *
 * @param body - Raw response body from a failed SDP API call.
 * @returns The specific reason, or `null` when the body carries none worth showing.
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

  if (reasonCode in REASON_CODE_LABELS) {
    return REASON_CODE_LABELS[reasonCode as PolicyEvaluationReasonCode];
  }

  // An unrecognised code still beats saying nothing — the API has emitted codes outside
  // the union before (`legacy_wallet_policy_denied`), and those are the ones most likely
  // to carry the detail an admin needs.
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
