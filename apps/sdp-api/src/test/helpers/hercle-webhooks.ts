import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { ExecutionContext } from "hono";
import { app } from "@/index";
import { env } from "@/test/helpers/env";

/** A P-256 key pair in the shape Hercle signs its webhooks with, the public half as SPKI PEM. */
export function hercleWebhookKeyPair(): { privateKey: KeyObject; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString() };
}

/** Hercle's verification event for `accountId`, stamped `timestamp` (Unix seconds) as Hercle stamps it. */
export function hercleVerificationBody(
  accountId: string,
  status: string,
  timestamp: number
): string {
  return JSON.stringify({
    event: "customer.verification.status_changed",
    timestamp,
    data: { accountId, status },
  });
}

/**
 * Posts a Hercle webhook to the public route and waits for its background apply.
 * Hercle signs `${X-Timestamp}.${rawBody}` and stamps the header with the envelope's own time.
 *
 * @param rawBody - The envelope.
 * @param privateKey - The key to sign with.
 * @param options.timestamp - The X-Timestamp, in Unix seconds; now by default.
 * @param options.environment - The endpoint's environment.
 */
export async function deliverHercleWebhook(
  rawBody: string,
  privateKey: KeyObject,
  {
    timestamp = Math.floor(Date.now() / 1000),
    environment = "sandbox",
  }: { timestamp?: number; environment?: SdpEnvironment } = {}
): Promise<Response> {
  const background: Promise<unknown>[] = [];
  const executionCtx: ExecutionContext = {
    waitUntil(promise) {
      background.push(promise);
    },
    passThroughOnException() {},
    props: {},
  };
  const signature = createSign("SHA256")
    .update(`${timestamp}.${rawBody}`)
    .sign(privateKey, "base64");
  const res = await app.request(
    `/webhooks/payments/ramps/${environment}/hercle`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Timestamp": String(timestamp),
        "X-Signature": signature,
      },
      body: rawBody,
    },
    env,
    executionCtx
  );
  await Promise.allSettled(background);
  return res;
}
