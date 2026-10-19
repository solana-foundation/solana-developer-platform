import { BoundedLruMap } from "@/lib/bounded-lru";
import { AppError, rateLimited } from "@/lib/errors";

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

/**
 * Keys over their own rate-limit tier, by hash, until the moment the limiter
 * would next admit them. A key in a retry loop past its tier otherwise costs a
 * Redis call and a full authorization read on every refused attempt, because
 * its tier is only known after that read.
 *
 * It holds a refusal, never an authorization: an entry only ever refuses, and
 * only until the limiter's own next admission time, so the key still gets its
 * tier's worth through. Per instance; another instance pays for its own first
 * refusal. A tier raised mid-window waits out the remainder of that window.
 */
const throttled = new BoundedLruMap<string, number>(TERMINAL_REFUSAL_MAX_TRACKED);

/** Throws RATE_LIMITED for a hash refused by its tier until a later instant. */
export function assertNotThrottled(
  keyHash: string,
  setRetryAfter: (seconds: number) => void,
  now = Date.now()
): void {
  const until = throttled.get(keyHash);
  if (until === undefined) {
    return;
  }
  if (until <= now) {
    throttled.delete(keyHash);
    return;
  }
  const retryAfter = Math.max(1, Math.ceil((until - now) / 1000));
  setRetryAfter(retryAfter);
  throw rateLimited(`Rate limit exceeded. Retry after ${retryAfter} seconds.`);
}

/** Remembers that the key's tier refuses it until `admitAtMs`. */
export function rememberThrottled(keyHash: string, admitAtMs: number): void {
  throttled.set(keyHash, admitAtMs);
}

/** Forget every refusal, so a test starts from a cold instance. */
export function resetTerminalRefusalsForTesting(): void {
  refusals.clear();
  throttled.clear();
}
