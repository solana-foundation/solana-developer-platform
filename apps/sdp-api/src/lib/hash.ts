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

export async function hmacSha256Base64(input: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(input));
  return Buffer.from(signature).toString("base64");
}

/**
 * Constant-time verification of a base64 HMAC-SHA256 signature over `input`.
 * Uses crypto.subtle.verify so the comparison is timing-safe.
 */
export async function verifyHmacSha256Base64(
  input: string,
  signatureBase64: string,
  secret: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  let signature: Uint8Array;
  try {
    signature = Uint8Array.from(Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(input));
}
