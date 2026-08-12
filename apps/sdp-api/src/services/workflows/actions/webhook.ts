import {
  createWebhookDeliveriesRepository,
  createWebhookEndpointsRepository,
  generateWebhookDeliveryId,
  type WorkflowExecutionRow,
} from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { readActionSecret } from "../action-secret";
import { resolveLiveEndpointSecrets } from "../endpoint-secret";
import { REQUEST_BODY_MAX_CHARS, sendWebhook, signLegacy, signV2 } from "../webhook-delivery";
import { permanentFail, resolveParam, succeeded, transientFail } from "./onchain";
import type { ActionContext, ActionExecutionResult } from "./types";

function buildEventBody(execution: WorkflowExecutionRow): string {
  return JSON.stringify({
    type: execution.trigger_type,
    tokenId: execution.token_id,
    workflowId: execution.workflow_id,
    executionId: execution.id,
    payload: execution.trigger_payload,
  });
}

// 5xx / 408 / 429 may clear on their own — retry with backoff. Other 4xx are endpoint
// config errors (bad path, auth) that retrying can't fix.
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

// send_webhook: POST the trigger event to a webhook target. Rules reference either a
// managed registry endpoint (`endpointId`) or, on the legacy MVP path, an inline `url`
// with an optional HMAC `secret`.
export async function runSendWebhook(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const endpointId = resolveParam(action, "endpointId");
  if (endpointId) {
    return runEndpointSendWebhook(env, execution, endpointId);
  }
  return runLegacySendWebhook(env, execution, action);
}

// Legacy MVP path: issuer-configured URL carried on the rule's action params. Optional
// `secret` HMAC-signs the body. Wire behavior (headers, signature scheme, retryability)
// is pinned by existing receivers and tests — do not change.
async function runLegacySendWebhook(
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
  const secret =
    (await readActionSecret(env, {
      orgId: execution.organization_id,
      stored: action.actionSecret,
    })) ?? resolveParam(action, "secret");

  const body = buildEventBody(execution);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "SDP-Workflows/1",
  };
  if (secret) {
    headers["x-sdp-signature-256"] = `sha256=${await signLegacy(secret, body)}`;
  }

  const outcome = await sendWebhook({ url, body, headers });
  if (!outcome.ok) {
    return outcome.kind === "blocked"
      ? permanentFail(outcome.reason)
      : transientFail(outcome.error);
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    return isRetryableStatus(outcome.status)
      ? transientFail(`HTTP_${outcome.status}`)
      : permanentFail(`HTTP_${outcome.status}`);
  }
  return succeeded({ status: outcome.status });
}

// Registry path: resolve the endpoint row, sign with its stored key(s) (both keys
// during a rotation grace window), and record every attempt in webhook_deliveries —
// the execution row only keeps the last attempt's aggregate state.
async function runEndpointSendWebhook(
  env: Env,
  execution: WorkflowExecutionRow,
  endpointId: string
): Promise<ActionExecutionResult> {
  const endpoint = await createWebhookEndpointsRepository(env).getEndpointById({
    endpointId,
    organizationId: execution.organization_id,
    projectId: execution.project_id,
    includeDeleted: true,
  });
  if (!endpoint) {
    // Nothing to attach a delivery row to.
    return permanentFail("ENDPOINT_NOT_FOUND");
  }

  const body = buildEventBody(execution);
  const deliveryId = generateWebhookDeliveryId();
  const logDelivery = async (fields: {
    status: "succeeded" | "failed";
    responseStatus?: number | null;
    responseBody?: string | null;
    error?: string | null;
    durationMs?: number | null;
  }): Promise<void> => {
    try {
      await createWebhookDeliveriesRepository(env).createDelivery({
        id: deliveryId,
        organizationId: execution.organization_id,
        projectId: execution.project_id,
        endpointId: endpoint.id,
        executionId: execution.id,
        workflowId: execution.workflow_id,
        triggerType: execution.trigger_type,
        attempt: execution.attempt_count,
        requestBody: body.slice(0, REQUEST_BODY_MAX_CHARS),
        requestBodyTruncated: body.length > REQUEST_BODY_MAX_CHARS,
        ...fields,
      });
    } catch (error) {
      // The delivery log is observability, not control flow: a failed insert must
      // never flip the action outcome (and never double-sends).
      getLogger().error({ error }, "Failed to record webhook delivery");
    }
  };

  if (endpoint.deleted_at) {
    await logDelivery({ status: "failed", error: "ENDPOINT_DELETED" });
    return permanentFail("ENDPOINT_DELETED");
  }
  if (endpoint.status !== "active") {
    await logDelivery({ status: "failed", error: "ENDPOINT_DISABLED" });
    return permanentFail("ENDPOINT_DISABLED");
  }

  const secrets = await resolveLiveEndpointSecrets(env, execution.organization_id, endpoint);
  if (!secrets) {
    // Store hiccups can clear; unlike the legacy path, a managed endpoint never
    // degrades to an unsigned delivery.
    await logDelivery({ status: "failed", error: "SECRET_UNAVAILABLE" });
    return transientFail("SECRET_UNAVAILABLE");
  }

  const timestampSeconds = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "SDP-Workflows/1",
    "x-sdp-delivery": deliveryId,
    "x-sdp-event": execution.trigger_type,
    "x-sdp-timestamp": String(timestampSeconds),
    "x-sdp-signature": await signV2(secrets, timestampSeconds, body),
  };

  const outcome = await sendWebhook({ url: endpoint.url, body, headers });
  if (!outcome.ok) {
    if (outcome.kind === "blocked") {
      await logDelivery({ status: "failed", error: outcome.reason });
      return permanentFail(outcome.reason);
    }
    await logDelivery({ status: "failed", error: outcome.error, durationMs: outcome.durationMs });
    return transientFail(outcome.error);
  }

  const delivered = outcome.status >= 200 && outcome.status < 300;
  await logDelivery({
    status: delivered ? "succeeded" : "failed",
    responseStatus: outcome.status,
    responseBody: outcome.responseBody || null,
    error: delivered ? null : `HTTP_${outcome.status}`,
    durationMs: outcome.durationMs,
  });
  if (!delivered) {
    return isRetryableStatus(outcome.status)
      ? transientFail(`HTTP_${outcome.status}`)
      : permanentFail(`HTTP_${outcome.status}`);
  }
  return succeeded({ status: outcome.status, deliveryId, endpointId: endpoint.id });
}
