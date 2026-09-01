// SPC session: mint and cache a JWT for a project principal's SPC user.
//
// An SDP actor never types SPC credentials. When SDP provisions a principal, it
// generates an SPC password and stores it encrypted on the compatibility
// private_channel_users row. Here we decrypt it and log in on the principal's
// behalf to obtain the SPC-issued JWT that gates the wallet APIs.
//
// The token is a 24h JWT with no refresh token, so "refresh" = re-login. When a
// KV `cache` + `instanceId` are supplied this becomes a read-through cache keyed
// per (instance, SPC user): reuse a token that is comfortably before expiry,
// otherwise re-login and cache the fresh one. The cache is best-effort — any KV
// or decrypt failure degrades to a plain login, never a hard error. Production
// callers go through `openSpcAuthContext` (see ./gateway-auth), which always
// supplies the cache when KV is configured.

import { redactCredentialSecrets } from "@sdp/custody";
import { PrivateChannelError } from "@sdp/private-channels";
import type { SpcAuthClient } from "@sdp/private-channels/auth";
import type { PrivateChannelUserRow } from "@/db/repositories";
import { createSpcCredentialCipher } from "@/lib/spc-credential-crypto";
import type { KVStore } from "@/runtime/kv";
import { getLogger } from "@/runtime/logger";
import type { CustodyCipher } from "@/services/custody-cipher/cipher-router";
import type { Env } from "@/types/env";

export interface SpcSession {
  /** SPC-issued JWT (24h) for challenge/verify/list/delete and gateway calls. */
  token: string;
  /** The SPC username the wallet is verified under. */
  username: string;
}

export interface GetSpcSessionOptions {
  /** KV store for read-through session reuse. Absent ⇒ fresh login every call. */
  cache?: KVStore;
  /** Instance the token is scoped to (its auth service mints it). Required to cache. */
  instanceId?: string;
  /** Skip the cache read, re-login, and overwrite (or evict) the cached entry. */
  forceRefresh?: boolean;
}

/** Re-login when within this of expiry, to absorb SDP↔SPC clock drift. */
const SESSION_REFRESH_SKEW_MS = 60_000;
/**
 * Don't cache a token whose USEFUL life (until `expiresAt - skew`) is below this.
 * KV's minimum expirationTtl is 60s and the read guard rejects anything already
 * inside the skew, so a shorter write would be a write-then-always-miss.
 */
const MIN_CACHEABLE_LIFETIME_MS = 120_000;
/** Fallback when the JWT carries no readable `exp` (the client documents 24h). */
const DEFAULT_JWT_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Time left until the skew cutoff (`expiresAt - skew`); ≤0 means treat as expired. */
function usefulLifetimeMs(expiresAt: number): number {
  return expiresAt - SESSION_REFRESH_SKEW_MS - Date.now();
}

/** Cached shape. `expiresAt` is PLAINTEXT so the skew guard needs no decrypt. */
interface CachedSpcSession {
  tokenCiphertext: string;
  /** Absolute expiry (ms epoch). */
  expiresAt: number;
}

function sessionCacheKey(instanceId: string, pcUserId: string): string {
  return `spc-session:${instanceId}:${pcUserId}`;
}

/**
 * Best-effort decode of a JWT's `exp` (in SECONDS) → absolute expiry in ms.
 * Untrusted input: a malformed/absent claim returns null so the caller falls back.
 * Deliberately local (not shared with `decodeJwtPayload` in middleware/rate-limit.ts)
 * to avoid coupling the session layer to unrelated auth middleware.
 */
function readJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Return a cached token still comfortably before expiry, or null (miss/expired/error). */
async function readCachedToken(
  cache: KVStore,
  key: string,
  organizationId: string,
  encryption: CustodyCipher
): Promise<string | null> {
  try {
    const cached = await cache.get<CachedSpcSession>(key, "json");
    if (!cached) {
      return null;
    }
    // Expiry is checked BEFORE decrypt (plaintext) so an expired entry costs no crypto.
    if (usefulLifetimeMs(cached.expiresAt) <= 0) {
      return null;
    }
    return await encryption.decrypt(organizationId, cached.tokenCiphertext);
  } catch (error) {
    // KV get failure, or decrypt failure — a rotated SPC_CREDENTIAL_ENCRYPTION_KEY
    // leaves undecryptable ciphertext, and on the KMS path this is a round trip that
    // a bad key name or missing IAM binding fails outright. Treat as a miss and
    // re-login rather than error out, but say so: silently degrading to a permanent
    // cache miss looks identical to a cold cache.
    getLogger().warn(
      redactCredentialSecrets({ organizationId, error }),
      "spc-session: cached token unusable, falling back to a fresh login"
    );
    return null;
  }
}

/** Cache a freshly minted token (best-effort). Evicts first on a forced refresh. */
async function cacheFreshToken(
  cache: KVStore,
  key: string,
  organizationId: string,
  encryption: CustodyCipher,
  token: string,
  forceRefresh: boolean
): Promise<void> {
  try {
    if (forceRefresh) {
      // Drop a possibly server-rejected entry so a concurrent/next read can't reuse
      // it — even in the branch below where the fresh token is too short-lived to cache.
      await cache.delete(key);
    }
    const expiresAt = readJwtExpiryMs(token) ?? Date.now() + DEFAULT_JWT_LIFETIME_MS;
    const usefulMs = usefulLifetimeMs(expiresAt);
    if (usefulMs < MIN_CACHEABLE_LIFETIME_MS) {
      return; // Too little life left to be worth a cache entry.
    }
    const ciphertext = await encryption.encrypt(organizationId, token);
    const entry: CachedSpcSession = { tokenCiphertext: ciphertext, expiresAt };
    await cache.put(key, JSON.stringify(entry), { expirationTtl: Math.ceil(usefulMs / 1000) });
  } catch (error) {
    // Caching is an optimization; a KV/encrypt failure must not fail the request. It
    // does mean every subsequent call re-logs in, so it is worth a line — on the KMS
    // path an encrypt failure is a misconfigured key, not a transient blip.
    getLogger().warn(
      redactCredentialSecrets({ organizationId, error }),
      "spc-session: could not cache the SPC token; subsequent calls will re-login"
    );
  }
}

/**
 * Obtain an SPC JWT for a project identity's SPC user. With `opts.cache` +
 * `opts.instanceId` this reads through a per-(instance, identity) KV cache,
 * refreshing before expiry; without them it logs in fresh every call. Throws
 * `FORBIDDEN` if the identity has no SPC credential (not fully provisioned).
 */
export async function getSpcSession(
  env: Env,
  organizationId: string,
  pcUser: PrivateChannelUserRow,
  authClient: SpcAuthClient,
  opts?: GetSpcSessionOptions
): Promise<SpcSession> {
  if (!pcUser.spc_username || !pcUser.spc_credential_ciphertext) {
    throw new PrivateChannelError(
      "FORBIDDEN",
      "This Private Channels identity has no SPC credential. Contact support."
    );
  }
  const username = pcUser.spc_username;
  const encryption = createSpcCredentialCipher(env);
  const cacheKey =
    opts?.cache && opts.instanceId ? sessionCacheKey(opts.instanceId, pcUser.id) : null;

  if (cacheKey && opts?.cache && !opts.forceRefresh) {
    const cachedToken = await readCachedToken(opts.cache, cacheKey, organizationId, encryption);
    if (cachedToken) {
      return { token: cachedToken, username };
    }
  }

  const password = await encryption.decrypt(organizationId, pcUser.spc_credential_ciphertext);
  const { token } = await authClient.login({ username, password });

  if (cacheKey && opts?.cache) {
    await cacheFreshToken(
      opts.cache,
      cacheKey,
      organizationId,
      encryption,
      token,
      opts.forceRefresh ?? false
    );
  }

  return { token, username };
}
