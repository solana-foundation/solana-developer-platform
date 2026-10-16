/**
 * Sealed (encrypted + session-bound) transport for the API-key flash cookie.
 *
 * The flash can carry a freshly generated API key secret, so the cookie value
 * is never plaintext: it is AES-256-GCM encrypted with a key derived from
 * CLERK_SECRET_KEY, and the payload records which Clerk session and user it
 * was minted for plus an absolute expiry. Unsealing requires the same
 * session/user and a fresh timestamp — a different account on the same
 * browser, a logged-out browser, or a replayed old cookie value all fail
 * closed to `null`.
 */

import type { ApiKeyFlash } from "./api-key-flash";

const SEAL_VERSION = "v1";
const KEY_CONTEXT = `sdp-api-key-flash:${SEAL_VERSION}`;

export interface FlashSessionClaims {
  sessionId: string;
  userId: string;
}

interface SealedFlashPayload {
  flash: ApiKeyFlash;
  sid: string;
  uid: string;
  /** Absolute expiry, epoch milliseconds. Enforced server-side on unseal. */
  exp: number;
}

async function deriveSealKey(secret: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`${KEY_CONTEXT}:${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function getSealSecret(): string | null {
  const secret = process.env.CLERK_SECRET_KEY;
  return secret && secret.length > 0 ? secret : null;
}

/**
 * Seal a flash for the given session. Returns null (never a plaintext
 * fallback) when no sealing secret is configured.
 */
export async function sealApiKeyFlash(
  flash: ApiKeyFlash,
  claims: FlashSessionClaims,
  ttlSeconds: number,
  now: number = Date.now()
): Promise<string | null> {
  const secret = getSealSecret();
  if (!secret) {
    return null;
  }

  const key = await deriveSealKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload: SealedFlashPayload = {
    flash,
    sid: claims.sessionId,
    uid: claims.userId,
    exp: now + ttlSeconds * 1000,
  };
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(payload))
  );

  return [
    SEAL_VERSION,
    Buffer.from(iv).toString("base64url"),
    Buffer.from(ciphertext).toString("base64url"),
  ].join(".");
}

/**
 * Unseal a flash cookie value for the current session. Returns null on any
 * failure: malformed value, wrong key, tampering, session or user mismatch,
 * or expiry.
 */
export async function unsealApiKeyFlash(
  sealed: string,
  claims: FlashSessionClaims,
  now: number = Date.now()
): Promise<ApiKeyFlash | null> {
  const secret = getSealSecret();
  if (!secret) {
    return null;
  }

  const [version, ivPart, cipherPart, ...rest] = sealed.split(".");
  if (version !== SEAL_VERSION || !ivPart || !cipherPart || rest.length > 0) {
    return null;
  }

  try {
    const key = await deriveSealKey(secret);
    const iv = Buffer.from(ivPart, "base64url");
    const ciphertext = Buffer.from(cipherPart, "base64url");
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as SealedFlashPayload;

    if (payload.sid !== claims.sessionId || payload.uid !== claims.userId) {
      return null;
    }
    if (typeof payload.exp !== "number" || payload.exp <= now) {
      return null;
    }

    return payload.flash;
  } catch {
    return null;
  }
}
