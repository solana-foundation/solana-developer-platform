import { createVerify } from "node:crypto";
import { unauthorized } from "@/lib/errors";

const encoder = new TextEncoder();

export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

type WebhookSignatureAlgorithm =
  | { type: "hmac-sha256"; secret: string; encoding: "base64" | "hex" }
  | { type: "ecdsa-sha256"; publicKeyPem: string };

export interface VerifyWebhookSignatureInput {
  provider: string;
  signature: string;
  signedPayload: string;
  algorithm: WebhookSignatureAlgorithm;
  /** Seconds since epoch from the provider's signed timestamp. Required — every provider
   * signs one (MoonPay header, Lightspark/BVNK body), and a non-finite value (missing or
   * unparseable) is rejected rather than skipping the replay window. */
  timestampSeconds: number;
}

function decodeSignature(signature: string, encoding: "base64" | "hex"): Uint8Array | null {
  if (encoding === "hex") {
    if (!/^[0-9a-f]+$/i.test(signature) || signature.length % 2 !== 0) {
      return null;
    }
    return Uint8Array.from(Buffer.from(signature, "hex"));
  }
  return Uint8Array.from(Buffer.from(signature, "base64"));
}

async function verifyHmacSha256(
  secret: string,
  signedPayload: string,
  signatureBytes: Uint8Array
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(signedPayload));
}

function verifyEcdsaSha256(
  publicKeyPem: string,
  signedPayload: string,
  signatureBytes: Uint8Array
): boolean {
  return createVerify("SHA256")
    .update(signedPayload)
    .verify(
      { key: publicKeyPem.replace(/\\n/g, "\n"), format: "pem", type: "spki" },
      signatureBytes
    );
}

export async function verifyWebhookSignature(input: VerifyWebhookSignatureInput): Promise<void> {
  const { provider, signature, signedPayload, algorithm, timestampSeconds } = input;

  if (!Number.isFinite(timestampSeconds)) {
    throw unauthorized(`Invalid ${provider} webhook timestamp`);
  }
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (ageSeconds > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    throw unauthorized(
      `${provider} webhook timestamp is outside the ${WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS}s tolerance window`
    );
  }

  const encoding = algorithm.type === "hmac-sha256" ? algorithm.encoding : "base64";
  const signatureBytes = decodeSignature(signature, encoding);
  if (!signatureBytes) {
    throw unauthorized(`Invalid ${provider} webhook signature`);
  }

  const valid =
    algorithm.type === "hmac-sha256"
      ? await verifyHmacSha256(algorithm.secret, signedPayload, signatureBytes)
      : verifyEcdsaSha256(algorithm.publicKeyPem, signedPayload, signatureBytes);

  if (!valid) {
    throw unauthorized(`Invalid ${provider} webhook signature`);
  }
}
