import { badRequest, providerUnavailable } from "@/lib/errors";

/**
 * Build failures whose reason belongs in front of the CALLER, not in a 500.
 *
 * Each names something the request or the vault's current state makes
 * impossible, and the provider's own sentence explains it better than any
 * status code:
 *
 * - `INVALID_AMOUNT` — the number is unusable at the mint's scale, or below
 *   what the vault will move an atom for.
 * - `DEPOSIT_REFUSED` / `WITHDRAW_REFUSED` — the vault will not take this
 *   right now: paused, at a cap, the asset disabled, shares still inside the
 *   post-deposit lock, redemption restricted to an authority.
 * - `COMPLIANCE_APPROVAL_REQUIRED` — the vault gates the move on an approval
 *   from the provider's compliance service, which SDP does not implement. A
 *   definite, explainable refusal rather than an internal fault.
 *
 * Matched on the shared `code` shape rather than provider classes, so a new
 * vault-direct provider inherits the mapping by using the same vocabulary.
 * Anything else keeps bubbling: an unrecognised build failure is SDP's problem
 * to look at, and telling a customer their request was wrong would be a guess.
 *
 * Shared by the vault BUILDS and the deposit QUOTE on purpose: the quote runs
 * the same provider arithmetic, so the two paths refuse in the same words or
 * they drift.
 */
const REFUSED_BUILD_CODES: ReadonlySet<string> = new Set([
  "INVALID_AMOUNT",
  "DEPOSIT_REFUSED",
  "WITHDRAW_REFUSED",
  "COMPLIANCE_APPROVAL_REQUIRED",
]);

function providerError(error: unknown): { code: string; message: string } | null {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") {
    return null;
  }
  return { code: error.code, message: error.message };
}

/**
 * Convert the provider-neutral vault error vocabulary into the public API
 * contract. Provider refusals are caller-fixable 400s. An unreadable vault is
 * an infrastructure failure, including RPC outages and rate limits, so it is
 * a retryable 503 with no provider or RPC internals exposed to the caller.
 */
export function rethrowVaultProviderFailure(error: unknown): never {
  const failure = providerError(error);
  if (failure && REFUSED_BUILD_CODES.has(failure.code)) {
    throw badRequest(failure.message);
  }
  if (failure?.code === "VAULT_UNREADABLE") {
    throw providerUnavailable("Earn provider is temporarily unavailable. Try again.");
  }
  throw error;
}
