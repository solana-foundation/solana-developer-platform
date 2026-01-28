/**
 * Fireblocks JWT utilities (Workers-safe)
 */

const encoder = new TextEncoder();

function base64Url(input: Uint8Array | ArrayBuffer | string): string {
  const bytes =
    typeof input === "string"
      ? encoder.encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

export async function importPrivateKey(pemPkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pemPkcs8),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

export async function createJwt(params: {
  apiKey: string;
  pathWithQuery: string;
  body: string;
  privateKey: CryptoKey;
}): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 25;
  const nonce = crypto.randomUUID();
  const bodyHashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(params.body));
  const bodyHash = toHex(bodyHashBuffer);

  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      uri: params.pathWithQuery,
      nonce,
      iat,
      exp,
      sub: params.apiKey,
      bodyHash,
    })
  );

  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    params.privateKey,
    encoder.encode(signingInput)
  );

  return `${signingInput}.${base64Url(signature)}`;
}
