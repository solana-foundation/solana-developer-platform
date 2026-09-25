import type { EarnVaultAsyncWithdrawalTermsRequest } from "@sdp/types";

/**
 * Canonical identity of one async-withdrawal preview request.
 *
 * A retained preview is bound to the fingerprint of the exact input that
 * produced it, and a preview whose fingerprint no longer matches the current
 * input is a stale quote for changed intent: it must never render and never
 * enable submission. Serialization sorts entries so the fingerprint depends
 * only on the intent's field values, not on key insertion order
 * (SOLA9-65).
 */
export function earnVaultPreviewInputFingerprint(
  input: EarnVaultAsyncWithdrawalTermsRequest
): string {
  return JSON.stringify(
    Object.entries(input).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  );
}
