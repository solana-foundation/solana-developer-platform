"use server";

import {
  type ConnectionProbeResult,
  privateChannelInstanceInputSchema,
} from "@sdp/private-channels";
import type { PrivateChannelInstance, PrivateChannelInstanceInput } from "@sdp/types";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";
import { summarizeProbeFailure } from "./probe-error";

const privateChannelInstanceSchema = privateChannelInstanceInputSchema.extend({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  isActive: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<PrivateChannelInstance>;

const gatewayProbeResponseSchema = z.object({
  status: z.number(),
  ok: z.boolean(),
  body: z.unknown().optional(),
});

const gatewayHealthResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    latencyMs: z.number(),
    health: gatewayProbeResponseSchema,
    ready: gatewayProbeResponseSchema,
  }),
  z.object({
    status: z.literal("degraded"),
    latencyMs: z.number(),
    health: gatewayProbeResponseSchema,
    ready: gatewayProbeResponseSchema,
    reason: z.string(),
  }),
  z.object({
    status: z.literal("unreachable"),
    latencyMs: z.number(),
    error: z.string(),
    health: gatewayProbeResponseSchema.optional(),
    ready: gatewayProbeResponseSchema.optional(),
  }),
]);

const rpcProbeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), latencyMs: z.number(), version: z.string() }),
  z.object({ ok: z.literal(false), latencyMs: z.number(), error: z.string() }),
]);

const authProbeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), latencyMs: z.number() }),
  z.object({ ok: z.literal(false), latencyMs: z.number(), error: z.string() }),
]);

const connectionProbeDetailsSchema = z.object({
  gateway: gatewayHealthResultSchema,
  rpc: rpcProbeResultSchema,
  auth: authProbeResultSchema,
});

export type FieldErrors = Partial<Record<keyof PrivateChannelInstanceInput, string>>;

export type TestConnectionResult =
  | { kind: "probe"; probe: ConnectionProbeResult }
  | { kind: "validation"; fieldErrors: FieldErrors }
  | { kind: "request-error"; message: string };

// Routes through the API so the probe runs in the same runtime as Connect's
// re-probe — a success here means Connect will not fail on the probe.
export async function testConnectionAction(input: {
  gatewayUrl: string;
  authUrl: string;
  escrowProgramId: string;
  escrowInstanceAddr: string;
}): Promise<TestConnectionResult> {
  const parsed = privateChannelInstanceInputSchema
    .pick({ gatewayUrl: true, authUrl: true, escrowProgramId: true, escrowInstanceAddr: true })
    .safeParse(input);
  if (!parsed.success) {
    return { kind: "validation", fieldErrors: flattenFieldErrors(parsed.error) };
  }

  try {
    const client = await createSdpApiClient();
    const probe = await client.fetch<ConnectionProbeResult>("/v1/private-channels/probe", {
      method: "POST",
      body: JSON.stringify(parsed.data),
    });
    return { kind: "probe", probe };
  } catch (error) {
    logActionFailure("testConnection", error);
    // The API client's diagnostic includes status codes, request IDs, and the
    // serialized response body. Keep that raw detail out of the product form,
    // but carry the API's own message so the alert names its cause instead of
    // rendering identically for every failure.
    return { kind: "request-error", message: describeFailure(error) };
  }
}

export type ConnectPrivateChannelResult =
  | { ok: true; instance: PrivateChannelInstance }
  | { ok: false; kind: "validation"; fieldErrors: FieldErrors }
  | { ok: false; kind: "probe"; probe: ConnectionProbeResult; message: string }
  | { ok: false; kind: "conflict-active"; message: string; activeInstance: PrivateChannelInstance }
  | {
      ok: false;
      kind: "requires-reactivate-confirmation";
      message: string;
      existingInstance: PrivateChannelInstance;
    }
  | { ok: false; kind: "server"; message: string };

export async function connectPrivateChannelAction(
  input: unknown
): Promise<ConnectPrivateChannelResult> {
  const parsed = privateChannelInstanceInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, kind: "validation", fieldErrors: flattenFieldErrors(parsed.error) };
  }
  const confirmReactivate = readConfirmReactivate(input);
  // The shared compatibility schema defaults an omitted legacy RPC URL to an
  // empty string for persistence. Do not turn that default back into a request
  // field: the API accepts omission while an explicitly empty URL is invalid.
  const { chainRpcUrl: _legacyChainRpcUrl, ...connectInput } = parsed.data;

  try {
    const client = await createSdpApiClient();
    const response = await client.fetch<{ instance: PrivateChannelInstance }>(
      "/v1/private-channels/instance",
      {
        method: "POST",
        body: JSON.stringify({ ...connectInput, confirmReactivate }),
      }
    );
    // Connecting flips the active instance, which changes the provider detail,
    // workspace tabs, and catalog status. Revalidate both the segment and catalog.
    revalidatePath("/dashboard/integrations/private-channels", "layout");
    revalidatePath("/dashboard/integrations");
    return { ok: true, instance: response.instance };
  } catch (error) {
    return interpretApiError("connect", error);
  }
}

/** Re-probe and save changed endpoints/program addresses for the active instance. */
export async function updatePrivateChannelAction(
  input: unknown
): Promise<ConnectPrivateChannelResult> {
  const parsed = privateChannelInstanceInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, kind: "validation", fieldErrors: flattenFieldErrors(parsed.error) };
  }
  const instanceId =
    input &&
    typeof input === "object" &&
    typeof (input as Record<string, unknown>).instanceId === "string"
      ? (input as Record<string, unknown>).instanceId
      : null;
  if (!instanceId) {
    return {
      ok: false,
      kind: "server",
      message: "The active instance is unavailable. Refresh and try again.",
    };
  }
  const { chainRpcUrl: _legacyChainRpcUrl, ...updateInput } = parsed.data;

  try {
    const client = await createSdpApiClient();
    const response = await client.fetch<{ instance: PrivateChannelInstance }>(
      "/v1/private-channels/instance",
      {
        method: "PATCH",
        body: JSON.stringify({ ...updateInput, instanceId }),
      }
    );
    revalidatePath("/dashboard/integrations/private-channels", "layout");
    revalidatePath("/dashboard/integrations");
    return { ok: true, instance: response.instance };
  } catch (error) {
    return interpretApiError("update", error);
  }
}

export type DisconnectResult =
  | { ok: true; instance: PrivateChannelInstance }
  | { ok: false; message: string };

export async function disconnectPrivateChannelAction(): Promise<DisconnectResult> {
  try {
    const client = await createSdpApiClient();
    const response = await client.fetch<{ instance: PrivateChannelInstance }>(
      "/v1/private-channels/instance/disconnect",
      { method: "POST", body: "{}" }
    );
    revalidatePath("/dashboard/integrations/private-channels", "layout");
    revalidatePath("/dashboard/integrations");
    return { ok: true, instance: response.instance };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export type DeleteResult = { ok: true } | { ok: false; message: string };

export async function deletePrivateChannelAction(): Promise<DeleteResult> {
  try {
    const client = await createSdpApiClient();
    await client.fetch<{ deleted: true }>("/v1/private-channels/instance", { method: "DELETE" });
    revalidatePath("/dashboard/integrations/private-channels/setup");
    revalidatePath("/dashboard/integrations");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

function readConfirmReactivate(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const value = (input as Record<string, unknown>).confirmReactivate;
  return value === true;
}

function flattenFieldErrors(error: import("zod").ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string") {
      const key = field as keyof PrivateChannelInstanceInput;
      if (!out[key]) out[key] = issue.message;
    }
  }
  return out;
}

function interpretApiError(action: string, error: unknown): ConnectPrivateChannelResult {
  logActionFailure(action, error);
  if (!(error instanceof Error)) {
    // Not an Error at all. Collapsing this into a generic string hid the only
    // evidence of what was thrown, so name the value instead.
    return { ok: false, kind: "server", message: describeFailure(error) };
  }
  const match = /^SDP API request failed \(\d+\):\s*([\s\S]*)$/.exec(error.message);
  if (!match) {
    // The API was never reached, or the client threw before the request went
    // out. "Unable to reach the SDP API" asserted the former for both.
    return { ok: false, kind: "server", message: describeFailure(error) };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(match[1] ?? "");
  } catch {
    // A non-JSON error body is usually an infrastructure page rather than the
    // API's own envelope. Keep a bounded excerpt: it identifies the responder.
    return { ok: false, kind: "server", message: describeFailure(error) };
  }

  const { details, message } = extractError(payload);
  // A parsed envelope with no `error.message` still carries the status and body.
  const displayMessage = message ?? describeFailure(error);

  const existingInstance = privateChannelInstanceSchema.safeParse(details?.existingInstance);
  if (details?.requiresReactivateConfirmation === true && existingInstance.success) {
    return {
      ok: false,
      kind: "requires-reactivate-confirmation",
      message: displayMessage,
      existingInstance: existingInstance.data,
    };
  }

  const activeInstance = privateChannelInstanceSchema.safeParse(details?.activeInstance);
  if (activeInstance.success) {
    return {
      ok: false,
      kind: "conflict-active",
      message: displayMessage,
      activeInstance: activeInstance.data,
    };
  }

  const probe = connectionProbeDetailsSchema.safeParse(details);
  if (probe.success) {
    return interpretProbeError(probe.data);
  }

  // API validation 400s carry one prettified message and no field map, so a
  // schema mismatch that slips past the client-side parse surfaces as the
  // server message rather than per-field errors.
  return { ok: false, kind: "server", message: displayMessage };
}

type ConnectionProbeDetails = z.infer<typeof connectionProbeDetailsSchema>;

function interpretProbeError(details: ConnectionProbeDetails): ConnectPrivateChannelResult {
  return {
    ok: false,
    kind: "probe",
    probe: { gateway: details.gateway, rpc: details.rpc, auth: details.auth, ok: false },
    message: summarizeProbeFailure(details),
  };
}

function extractError(payload: unknown): {
  details: Record<string, unknown> | null;
  message: string | null;
} {
  const record = isRecord(payload) ? payload : null;
  const errorField = record && isRecord(record.error) ? record.error : null;
  const details = errorField && isRecord(errorField.details) ? errorField.details : null;
  const message = errorField && typeof errorField.message === "string" ? errorField.message : null;
  return { details, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Upper bound on error text rendered in the form; HTML error pages are long. */
const MAX_FAILURE_DETAIL = 200;

/**
 * A short, human-readable description of a thrown value.
 *
 * Every branch that produced a fixed string used to discard the only record of
 * what failed: these actions catch, and a caught throw reaches no server log.
 */
function describeFailure(error: unknown): string {
  const text = rawFailureText(error).trim();
  if (!text) return "Request failed.";
  return text.length > MAX_FAILURE_DETAIL ? `${text.slice(0, MAX_FAILURE_DETAIL)}…` : text;
}

function rawFailureText(error: unknown): string {
  if (error instanceof Error) return extractSdpApiErrorMessage(error);
  if (typeof error === "string") return error;
  // A thrown non-Error is the case worth naming precisely: serialize it so a
  // framework control-flow object shows its `digest` rather than vanishing.
  if (error === null || error === undefined) return "";
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Emit the thrown value's identity to the server log.
 *
 * `instanceof Error` is the branch these actions key on, and a non-Error throw
 * (a framework control-flow object, say) is indistinguishable from an API
 * failure once it has been flattened to a message. Record both.
 */
function logActionFailure(action: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event: "private_channels_action_failed",
      action,
      isError: error instanceof Error,
      name: error instanceof Error ? error.name : undefined,
      constructor: (error as { constructor?: { name?: string } })?.constructor?.name,
      digest: (error as { digest?: unknown })?.digest,
      raw: describeFailure(error),
    })
  );
}
