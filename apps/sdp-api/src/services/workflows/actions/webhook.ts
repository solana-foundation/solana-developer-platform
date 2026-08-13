import type { WorkflowExecutionRow } from "@/db/repositories";
import type { Env } from "@/types/env";
import { readActionSecret } from "../action-secret";
import { resolveWebhookUrl } from "../webhook-url";
import { errorMessage, permanentFail, resolveParam, succeeded, transientFail } from "./onchain";
import type { ActionContext, ActionExecutionResult } from "./types";

const REQUEST_TIMEOUT_MS = 10_000;
// Deliveries are one-shot POSTs; a chain of redirects is far more likely to be an
// SSRF pivot than a real endpoint move, so we follow at most one and re-validate it.
const MAX_REDIRECTS = 1;
const encoder = new TextEncoder();

// HMAC-SHA256 hex signature over the payload — the outbound mirror of the inbound
// `verifyHmacSha256` (crypto.subtle, Workers-native). Lets the receiver authenticate
// that the delivery genuinely came from SDP.
async function signPayload(secret: string, payload: string): Promise<string> {
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

// One hop of the delivery, with redirects handled by hand so each target is re-checked
// against the SSRF rules before we connect to it.
async function deliver(
  target: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<{ ok: true; response: Response } | { ok: false; result: ActionExecutionResult }> {
  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = await resolveWebhookUrl(current);
    if (!checked.ok) {
      // An endpoint that resolves into private space is a config error (or an attempt);
      // retrying re-runs the same lookup, so fail permanently.
      return { ok: false, result: permanentFail(`BLOCKED_URL:${checked.reason}`) };
    }
    const response = await fetch(checked.url, { ...init, redirect: "manual", signal });
    if (response.status < 300 || response.status >= 400) {
      return { ok: true, response };
    }
    const location = response.headers.get("location");
    // Drain before abandoning the connection.
    await response.arrayBuffer().catch(() => undefined);
    if (!location) {
      return { ok: true, response };
    }
    current = new URL(location, checked.url).toString();
  }
  return { ok: false, result: permanentFail("TOO_MANY_REDIRECTS") };
}

// send_webhook (MVP): POST the trigger event to the issuer-configured URL carried on the
// rule's action params. Optional `secret` HMAC-signs the body. 5xx/408/429 and
// network/timeout errors are transient (the engine retries with backoff); other 4xx, a
// missing/malformed URL and an SSRF-blocked target are permanent config errors.
export async function runSendWebhook(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const url = resolveParam(action, "url");
  if (!url) {
    return permanentFail("MISSING_PARAM:url");
  }
  // The signing key lives in the credential store; `params.secret` is only a fallback
  // for a rule saved before that (and for tests that pass one inline).
  const stored = await readActionSecret(env, {
    orgId: execution.organization_id,
    stored: action.actionSecret,
  });
  // A rule that HAS a signing key must never deliver without one. Sending unsigned
  // because the store was briefly unavailable strips the receiver's only means of
  // authenticating the payload — and a receiver that correctly rejects it would see a
  // permanent 4xx rather than the retry this deserves. Transient: the engine retries
  // with backoff, and a store that stays down ends as a visible failure instead of a
  // stream of unsigned deliveries.
  if (!stored.ok) {
    return transientFail("SECRET_UNREADABLE");
  }
  const secret = stored.secret ?? resolveParam(action, "secret");

  const body = JSON.stringify({
    type: execution.trigger_type,
    tokenId: execution.token_id,
    workflowId: execution.workflow_id,
    executionId: execution.id,
    payload: execution.trigger_payload,
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "SDP-Workflows/1",
  };
  if (secret) {
    headers["x-sdp-signature-256"] = `sha256=${await signPayload(secret, body)}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const delivery = await deliver(url, { method: "POST", headers, body }, controller.signal);
    if (!delivery.ok) {
      return delivery.result;
    }
    const { response } = delivery;
    // The body is never used, but leaving it unread holds the socket open.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) {
      // 5xx / 408 / 429 may clear on their own — retry with backoff. Other 4xx are
      // endpoint config errors (bad path, auth) that retrying can't fix.
      const retryable =
        response.status >= 500 || response.status === 408 || response.status === 429;
      return retryable
        ? transientFail(`HTTP_${response.status}`)
        : permanentFail(`HTTP_${response.status}`);
    }
    return succeeded({ status: response.status });
  } catch (error) {
    return transientFail(errorMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}
