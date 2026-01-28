/**
 * Hash utilities using Web Crypto
 */

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hash a string using HMAC-SHA-256 when a secret is provided,
 * otherwise fall back to SHA-256.
 */
export async function hashString(input: string, secret?: string): Promise<string> {
  const data = encoder.encode(input);

  if (secret && secret.length > 0) {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, data);
    return toHex(signature);
  }

  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}
