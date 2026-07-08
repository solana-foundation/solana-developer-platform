import { createVerify } from "node:crypto";
import { unauthorized } from "@/lib/errors";

const encoder = new TextEncoder();

export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

type WebhookSignatureEncoding = "base64" | "hex";

type WebhookSignatureAlgorithm =
  | { type: "hmac-sha256"; secret: string; encoding: WebhookSignatureEncoding }
  | { type: "ecdsa-sha256"; publicKeyPem: string; encoding: WebhookSignatureEncoding };

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

/**
 * Verifies an HMAC-SHA256 webhook signature against the provider's signed payload.
 *
 * @param secret - Shared webhook signing secret configured for the provider.
 * @param signedPayload - Exact string the provider signed, usually the raw body or timestamp-prefixed body.
 * @param signatureBytes - Decoded signature bytes from the provider header.
 * @returns Whether the signature matches the payload for the given secret.
 */
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

/**
 * Verifies an ECDSA P-256/SHA-256 webhook signature against the provider's signed payload.
 *
 * @param publicKeyPem - Provider webhook public key in PEM/SPKI format. Literal "\\n"
 * sequences are normalized to real newlines before verification because PEM keys are
 * commonly stored in environment variables that way.
 * @param signedPayload - Exact string the provider signed, usually the raw request body.
 * @param signatureBytes - Decoded DER signature bytes from the provider header.
 * @returns Whether the signature matches the payload for the given public key.
 */
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

/**
 * Validates a provider webhook timestamp and signature.
 *
 * @param input - Provider name, raw signature, signed payload, algorithm details, and signed timestamp.
 * @returns Resolves when the timestamp is fresh and the signature is valid; throws an unauthorized error otherwise.
 */
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

  let signatureBytes: Uint8Array;
  switch (algorithm.encoding) {
    case "hex":
      if (!/^[0-9a-f]+$/i.test(signature) || signature.length % 2 !== 0) {
        throw unauthorized(`Invalid ${provider} webhook signature`);
      }
      signatureBytes = Uint8Array.from(Buffer.from(signature, "hex"));
      break;
    case "base64":
      signatureBytes = Uint8Array.from(Buffer.from(signature, "base64"));
      break;
  }

  if (signatureBytes.length === 0) {
    throw unauthorized(`Invalid ${provider} webhook signature`);
  }

  let valid: boolean;
  switch (algorithm.type) {
    case "hmac-sha256":
      valid = await verifyHmacSha256(algorithm.secret, signedPayload, signatureBytes);
      break;
    case "ecdsa-sha256":
      valid = verifyEcdsaSha256(algorithm.publicKeyPem, signedPayload, signatureBytes);
      break;
  }

  if (!valid) {
    throw unauthorized(`Invalid ${provider} webhook signature`);
  }
}
