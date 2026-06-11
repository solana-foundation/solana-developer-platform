// biome-ignore lint/security/noSecrets: This is the public Base58 alphabet, not a secret.
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  d?: string;
}

export interface LocalSignerKeypair {
  publicKey: string;
  privateKey: string;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  let leadingZeroes = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeroes += 1;
  }
  if (leadingZeroes === bytes.length) return BASE58_ALPHABET[0].repeat(leadingZeroes);

  const digits: number[] = [];
  for (const byte of bytes.subarray(leadingZeroes)) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      const value = digits[i] * 256 + carry;
      digits[i] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  return `${BASE58_ALPHABET[0].repeat(leadingZeroes)}${digits
    .reverse()
    .map((digit) => BASE58_ALPHABET[digit])
    .join("")}`;
}

export async function generateLocalSignerKeypair(): Promise<LocalSignerKeypair> {
  const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in generated) || !("publicKey" in generated)) {
    throw new Error("Ed25519 generation did not return a keypair.");
  }
  const keypair = generated as { privateKey: CryptoKey; publicKey: CryptoKey };
  const privateJwk = (await crypto.subtle.exportKey("jwk", keypair.privateKey)) as Ed25519Jwk;
  const publicJwk = (await crypto.subtle.exportKey("jwk", keypair.publicKey)) as Ed25519Jwk;

  if (privateJwk.crv !== "Ed25519" || publicJwk.crv !== "Ed25519" || !privateJwk.d) {
    throw new Error("Generated keypair is not an extractable Ed25519 keypair.");
  }

  const seed = base64UrlToBytes(privateJwk.d);
  const publicKeyBytes = base64UrlToBytes(publicJwk.x);
  if (seed.length !== 32 || publicKeyBytes.length !== 32) {
    throw new Error(
      `Unexpected Ed25519 key sizes: seed=${seed.length} public=${publicKeyBytes.length}`
    );
  }

  const secretKey = new Uint8Array(64);
  secretKey.set(seed, 0);
  secretKey.set(publicKeyBytes, 32);

  return {
    publicKey: encodeBase58(publicKeyBytes),
    privateKey: encodeBase58(secretKey),
  };
}
