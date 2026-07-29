import type { WorkflowExecutionRow } from "@/db/repositories";
import type { Env } from "@/types/env";
import { errorMessage, permanentFail, resolveParam, succeeded, transientFail } from "./onchain";
import type { ActionContext, ActionExecutionResult } from "./types";

const REQUEST_TIMEOUT_MS = 10_000;
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

// send_webhook (MVP): POST the trigger event to the issuer-configured URL carried on the
// rule's action params. Optional `secret` HMAC-signs the body. A non-2xx response or a
// network/timeout error is transient (the engine retries with backoff); a missing or
// malformed URL is a permanent config error.
export async function runSendWebhook(
  _env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const url = resolveParam(action, "url");
  if (!url) {
    return permanentFail("MISSING_PARAM:url");
  }
  if (!/^https?:\/\//i.test(url)) {
    return permanentFail("INVALID_PARAM:url");
  }
  const secret = resolveParam(action, "secret");

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
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      // 4xx/5xx — retry; a persistently-broken endpoint fails at the attempt cap.
      return transientFail(`HTTP_${response.status}`);
    }
    return succeeded({ status: response.status });
  } catch (error) {
    return transientFail(errorMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}
