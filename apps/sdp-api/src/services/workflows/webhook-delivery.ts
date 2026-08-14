// Shared outbound-webhook delivery core: signing + the SSRF-guarded POST. Used by the
// send_webhook action (both the legacy inline-url path and registry endpoints) and by
// the registry's manual-redeliver handler, so wire behavior can't drift between them.

import { resolveWebhookUrl } from "./webhook-url";

export const WEBHOOK_TIMEOUT_MS = 10_000;
// Deliveries are one-shot POSTs; a chain of redirects is far more likely to be an
// SSRF pivot than a real endpoint move, so we follow at most one and re-validate it.
const MAX_REDIRECTS = 1;
// Storage caps for the delivery log. The response cap truncates silently; the request
// cap sets a flag instead (redelivery refuses truncated rows — byte-identity is gone).
export const RESPONSE_BODY_MAX_CHARS = 4_096;
export const REQUEST_BODY_MAX_CHARS = 65_536;

const encoder = new TextEncoder();

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Legacy scheme (inline-url rules): HMAC over the raw body alone, sent as
// `x-sdp-signature-256: sha256=<hex>`. Pinned by existing receivers — do not change.
export async function signLegacy(secret: string, payload: string): Promise<string> {
  return hmacSha256Hex(secret, payload);
}

// Registry scheme: `t=<unix>,v1=<hex>[,v1=<hex>]`, HMAC over `${t}.${body}` (Stripe
// composition — the timestamp inside the signed payload gives replay protection).
// During a rotation grace window there is one v1 entry per live key, current first.
export async function signV2(
  secrets: string[],
  timestampSeconds: number,
  body: string
): Promise<string> {
  const signedPayload = `${timestampSeconds}.${body}`;
  const parts = [`t=${timestampSeconds}`];
  for (const secret of secrets) {
    parts.push(`v1=${await hmacSha256Hex(secret, signedPayload)}`);
  }
  return parts.join(",");
}

export type WebhookSendOutcome =
  // `status` may be any non-redirect status; the caller owns retryability mapping.
  | {
      ok: true;
      status: number;
      responseBody: string;
      responseBodyTruncated: boolean;
      durationMs: number;
    }
  // SSRF-blocked target or redirect chain: a permanent config error (or an attempt).
  | { ok: false; kind: "blocked"; reason: string }
  // Timeout / socket error: transient, the engine retries with backoff.
  | { ok: false; kind: "network"; error: string; durationMs: number };

// One delivery attempt, with redirects handled by hand so each target is re-checked
// against the SSRF rules before we connect to it.
export async function sendWebhook(params: {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}): Promise<WebhookSendOutcome> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
  try {
    let current = params.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const checked = await resolveWebhookUrl(current);
      if (!checked.ok) {
        return { ok: false, kind: "blocked", reason: `BLOCKED_URL:${checked.reason}` };
      }
      const response = await fetch(checked.url, {
        method: "POST",
        headers: params.headers,
        body: params.body,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) {
        const body = await readTruncatedBody(response);
        return {
          ok: true,
          status: response.status,
          responseBody: body.text,
          responseBodyTruncated: body.truncated,
          durationMs: Date.now() - started,
        };
      }
      const location = response.headers.get("location");
      // Abandon the redirect body without reading it — the receiver controls its size,
      // so draining it into memory hands a hostile endpoint an allocation of its choice.
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        return {
          ok: true,
          status: response.status,
          responseBody: "",
          responseBodyTruncated: false,
          durationMs: Date.now() - started,
        };
      }
      current = new URL(location, checked.url).toString();
    }
    return { ok: false, kind: "blocked", reason: "TOO_MANY_REDIRECTS" };
  } catch (error) {
    return {
      ok: false,
      kind: "network",
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Streamed with a hard cap, never buffered whole: the receiver controls the response
// size, and `response.text()` would hand a hostile endpoint an arbitrarily large
// allocation inside the send timeout. Reading stops one chunk past the cap (so
// `truncated` is a fact, not a guess) and the rest of the stream is cancelled.
async function readTruncatedBody(
  response: Response
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { text: "", truncated: false };
  }
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length <= RESPONSE_BODY_MAX_CHARS) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // A body that dies mid-read keeps what already arrived.
  } finally {
    reader.cancel().catch(() => undefined);
  }
  if (text.length > RESPONSE_BODY_MAX_CHARS) {
    return { text: text.slice(0, RESPONSE_BODY_MAX_CHARS), truncated: true };
  }
  return { text, truncated: false };
}
