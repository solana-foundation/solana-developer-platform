import { BoundedLruMap } from "@/lib/bounded-lru";
import { AppError } from "@/lib/errors";

/**
 * Terminal API-key refusals remembered in this instance's memory, so a
 * revoked key left in a retry loop, or a hash that names no key, stops
 * costing a Redis call and a DB read on every attempt.
 *
 * Only refusals that cannot become admissions are cached:
 * - an unknown hash: a new key's hash is random, so it cannot have been
 *   probed before the key existed;
 * - a revoked key, or one past its rotation deadline: neither comes back
 *   (deadlines only move earlier);
 * - an expired key: expiry is final unless someone extends `expires_at`, in
 *   which case this instance refuses it for at most the TTL longer.
 *
 * Never an active key, and never a refusal that can lift (an inactive
 * organization or project, an IP restriction). No invalidation is needed: an
 * entry can only be stale by refusing something that is still refused.
 */
export const TERMINAL_REFUSAL_TTL_MS = 60_000;

/** Distinct key hashes remembered per instance. */
const TERMINAL_REFUSAL_MAX_TRACKED = 10_000;

export type TerminalRefusal = "INVALID_API_KEY" | "REVOKED_API_KEY" | "EXPIRED_API_KEY";

const refusals = new BoundedLruMap<string, { code: TerminalRefusal; until: number }>(
  TERMINAL_REFUSAL_MAX_TRACKED
);

function refusalError(code: TerminalRefusal): AppError {
  return code === "INVALID_API_KEY"
    ? new AppError("INVALID_API_KEY", "Invalid API key")
    : new AppError(code);
}

/** Throws the remembered refusal for this hash, if one is still fresh. */
export function assertNoCachedTerminalRefusal(keyHash: string, now = Date.now()): void {
  const cached = refusals.get(keyHash);
  if (!cached) {
    return;
  }
  if (cached.until <= now) {
    refusals.delete(keyHash);
    return;
  }
  throw refusalError(cached.code);
}

/** Remembers a terminal refusal and returns the error to throw for it. */
export function refuseTerminally(
  keyHash: string,
  code: TerminalRefusal,
  now = Date.now()
): AppError {
  refusals.set(keyHash, { code, until: now + TERMINAL_REFUSAL_TTL_MS });
  return refusalError(code);
}

/** Forget every refusal, so a test starts from a cold instance. */
export function resetTerminalRefusalsForTesting(): void {
  refusals.clear();
}
