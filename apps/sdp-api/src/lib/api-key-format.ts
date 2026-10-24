import type { Context } from "hono";
import type { Env } from "@/types/env";

/**
 * The shared Foundation API key format (HOO-2256), which the API gateway will
 * issue and verify for every Foundation API:
 *
 *   sf_<key id>_<secret><checksum>
 *
 * - key id: 16 lowercase hex (64 random bits); safe to log and display, and
 *   what the gateway's signed identity names the key by.
 * - secret: 43 base62 (256 random bits); stored only as a peppered HMAC.
 * - checksum: CRC32 of `sf_<key id>_<secret>`, 6 base62; rejects a typo before
 *   any hash or read, and lets secret scanners match a leaked key exactly.
 *
 * There is no product or environment in the key. SDP issues these itself until
 * the gateway's control plane takes over issuance and imports them without a
 * reissue, so this layout must stay in step with the gateway's key spec: CRC32
 * (IEEE) over `sf_<key id>_<secret>`, base62 `0-9A-Za-z`, and
 * HMAC-SHA256(pepper, secret) stored with its `pepper_version`.
 */
export const SF_API_KEY_PREFIX = "sf_";
/** Issued before HOO-2256; still accepted, no longer issued. */
const LEGACY_API_KEY_PREFIX = "sk_";

// biome-ignore lint/security/noSecrets: the base62 alphabet, not a secret
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SF_KEY_ID_BYTES = 8;
const SF_SECRET_BYTES = 32;
const SF_SECRET_LENGTH = 43;
const SF_CHECKSUM_LENGTH = 6;
const SF_API_KEY_PATTERN = /^sf_([0-9a-f]{16})_([0-9A-Za-z]{43})([0-9A-Za-z]{6})$/;

export interface SfApiKey {
  /** The 16-hex key ID: `api_keys.public_id`. */
  keyId: string;
  /** The 43-base62 secret: the only part that is hashed. */
  secret: string;
}

/** Fixed-width base62 of a big-endian unsigned integer. */
function toBase62(value: bigint, width: number): string {
  let rest = value;
  let out = "";
  while (rest > 0n) {
    out = BASE62_ALPHABET[Number(rest % 62n)] + out;
    rest /= 62n;
  }
  if (out.length > width) {
    throw new Error(`base62 value exceeds ${width} characters`);
  }
  return out.padStart(width, "0");
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, as zlib) of a string's UTF-8 bytes. */
export function crc32(input: string): number {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(input)) {
    // SAFETY: The masked index is 0-255, and all 256 table entries are initialized.
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sfChecksum(body: string): string {
  return toBase62(BigInt(crc32(body)), SF_CHECKSUM_LENGTH);
}

/** Formats an `sf_` key from its parts, appending the checksum. */
export function formatSfApiKey({ keyId, secret }: SfApiKey): string {
  const body = `${SF_API_KEY_PREFIX}${keyId}_${secret}`;
  return `${body}${sfChecksum(body)}`;
}

/** A fresh `sf_` key: a random key ID and a 256-bit secret. */
export function generateSfApiKey(): SfApiKey & { key: string } {
  const idBytes = new Uint8Array(SF_KEY_ID_BYTES);
  const secretBytes = new Uint8Array(SF_SECRET_BYTES);
  crypto.getRandomValues(idBytes);
  crypto.getRandomValues(secretBytes);
  const keyId = Array.from(idBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const secret = toBase62(bytesToBigInt(secretBytes), SF_SECRET_LENGTH);
  return { keyId, secret, key: formatSfApiKey({ keyId, secret }) };
}

/**
 * Splits an `sf_` key into its key ID and secret, or returns null when it is
 * malformed or its checksum does not match.
 */
export function parseSfApiKey(token: string): SfApiKey | null {
  const match = SF_API_KEY_PATTERN.exec(token);
  if (!match) {
    return null;
  }
  const [, keyId, secret, checksum] = match;
  if (keyId === undefined || secret === undefined || checksum === undefined) {
    return null;
  }
  if (sfChecksum(`${SF_API_KEY_PREFIX}${keyId}_${secret}`) !== checksum) {
    return null;
  }
  return { keyId, secret };
}

/**
 * Extracts the API key credential from the Authorization header, supporting
 * both "Bearer <key>" and a raw key value.
 */
export function extractApiKey(c: Context<{ Bindings: Env }>): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return null;
  }

  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  if (looksLikeApiKey(authHeader)) {
    return authHeader;
  }

  return null;
}

/**
 * Checks whether a credential is shaped like an SDP API key. Shared by auth
 * (key lookup) and pre-auth rate limiting (anonymous limit vs keyed backstop),
 * which must agree on what counts as a key.
 */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(SF_API_KEY_PREFIX) || token.startsWith(LEGACY_API_KEY_PREFIX);
}

/** A presented API key, as far as its format alone can tell. */
export type PresentedApiKey =
  | { format: "sf"; keyId: string; secret: string }
  | { format: "legacy"; key: string };

/**
 * Classifies a presented key by format, or returns null when it is neither a
 * well-formed `sf_` key (checksum included) nor a legacy `sk_test_`/`sk_live_`
 * key.
 */
export function parsePresentedApiKey(token: string): PresentedApiKey | null {
  if (token.startsWith(SF_API_KEY_PREFIX)) {
    const parsed = parseSfApiKey(token);
    return parsed ? { format: "sf", ...parsed } : null;
  }
  if (token.startsWith("sk_test_") || token.startsWith("sk_live_")) {
    return { format: "legacy", key: token };
  }
  return null;
}
